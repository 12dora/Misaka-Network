// QUALITY-001: terminal transfer state had no bounded retention policy.
//
// There is no transfer-history feature, so a record whose status is
// `completed` / `failed` / `failed:unsupported` has no consumer once its card
// leaves the screen — yet every send and every receive left one behind
// forever. Long-lived installs accumulated tens of thousands of rows, which
// slows the full-store scan `getActiveTransfers()` does on EVERY reconnect and
// burns the origin quota that the active transfers need. Failed IDB-mode
// receives also left their chunk rows behind, which is the expensive part.
//
// The policy lives in exactly one place (`pruneTerminalTransfers`) and is
// bounded by BOTH age and count; live rows are never touched.

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('idb', () => {
  const stores: Record<string, Map<string, unknown>> = {}

  function inRange(key: string, range: IDBKeyRange | undefined): boolean {
    if (!range) return true
    const lower = range.lower as string | undefined
    const upper = range.upper as string | undefined
    if (lower !== undefined) {
      if (range.lowerOpen ? !(key > lower) : !(key >= lower)) return false
    }
    if (upper !== undefined) {
      if (range.upperOpen ? !(key < upper) : !(key <= upper)) return false
    }
    return true
  }

  function makeStore(name: string) {
    if (!stores[name]) stores[name] = new Map()
    const store = stores[name]
    return {
      async get(key: string) { return store.get(key) },
      async put(value: unknown, key?: string) {
        if (key !== undefined) store.set(key, value)
        else store.set((value as { transferId: string }).transferId, value)
      },
      async delete(keyOrRange: string | IDBKeyRange) {
        if (typeof keyOrRange === 'string') store.delete(keyOrRange)
        else {
          for (const k of Array.from(store.keys())) {
            if (inRange(k, keyOrRange)) store.delete(k)
          }
        }
      },
      async getAll() { return Array.from(store.values()) },
      async getAllKeys(range?: IDBKeyRange) {
        return Array.from(store.keys()).filter(k => inRange(k, range))
      },
    }
  }

  function makeTx(name: string) {
    return { store: makeStore(name), done: Promise.resolve() }
  }

  function openDB(_name: string, _version: number, opts: { upgrade: (db: unknown) => void }) {
    opts.upgrade({
      objectStoreNames: { contains: () => false },
      createObjectStore: () => undefined,
    })
    return Promise.resolve({
      get: (name: string, key: string) => makeStore(name).get(key),
      put: (name: string, value: unknown, key?: string) => makeStore(name).put(value, key),
      delete: (name: string, key: string | IDBKeyRange) => makeStore(name).delete(key),
      getAll: (name: string) => makeStore(name).getAll(),
      getAllKeys: (name: string, range?: IDBKeyRange) => makeStore(name).getAllKeys(range),
      transaction: (name: string) => makeTx(name),
    })
  }

  ;(openDB as unknown as { __reset: () => void }).__reset = () => {
    for (const k of Object.keys(stores)) delete stores[k]
  }

  return { openDB }
})

;(globalThis as any).IDBKeyRange = {
  bound(lower: string, upper: string, lowerOpen = false, upperOpen = false) {
    return { lower, upper, lowerOpen, upperOpen } as unknown as IDBKeyRange
  },
}

import {
  saveTransfer, getTransfer, saveChunk, getChunk,
  pruneTerminalTransfers, isTerminalStatus,
  TERMINAL_RETENTION_MS, TERMINAL_RETENTION_MAX,
  type TransferRecord,
} from '../../src/lib/db'
import * as idb from 'idb'

const NOW = 1_800_000_000_000

function record(id: string, status: TransferRecord['status'], updatedAt: number): TransferRecord {
  return {
    transferId: id, direction: 'recv', peerNodeId: 1, peerSessionId: 'sess', epoch: 0,
    fileName: `${id}.bin`, fileSize: 10, fileHash: '', totalChunks: 1,
    receivedChunks: [], status, createdAt: updatedAt, updatedAt,
  }
}

beforeEach(() => {
  ;(idb.openDB as unknown as { __reset: () => void }).__reset()
})

describe('QUALITY-001: terminal retention policy', () => {
  it('classifies terminal vs live statuses', () => {
    expect(isTerminalStatus('completed')).toBe(true)
    expect(isTerminalStatus('failed')).toBe(true)
    expect(isTerminalStatus('failed:unsupported')).toBe(true)
    expect(isTerminalStatus('active')).toBe(false)
    expect(isTerminalStatus('paused')).toBe(false)
  })

  it('NEVER prunes active or paused rows — they are resume state', async () => {
    await saveTransfer(record('live-1', 'active', NOW - TERMINAL_RETENTION_MS * 10))
    await saveTransfer(record('live-2', 'paused', NOW - TERMINAL_RETENTION_MS * 10))
    const removed = await pruneTerminalTransfers({ now: NOW })
    expect(removed).toBe(0)
    expect(await getTransfer('live-1')).toBeTruthy()
    expect(await getTransfer('live-2')).toBeTruthy()
  })

  it('prunes terminal rows older than the age bound', async () => {
    await saveTransfer(record('old', 'completed', NOW - TERMINAL_RETENTION_MS - 1))
    await saveTransfer(record('fresh', 'completed', NOW - 1000))
    const removed = await pruneTerminalTransfers({ now: NOW })
    expect(removed).toBe(1)
    expect(await getTransfer('old')).toBeUndefined()
    expect(await getTransfer('fresh')).toBeTruthy()
  })

  it('prunes beyond the count bound, keeping the NEWEST rows', async () => {
    const total = TERMINAL_RETENTION_MAX + 12
    for (let i = 0; i < total; i++) {
      await saveTransfer(record(`c-${i}`, 'completed', NOW - (total - i) * 1000))
    }
    const removed = await pruneTerminalTransfers({ now: NOW })
    expect(removed).toBe(12)
    // c-0 is the oldest → gone; the last one is the newest → kept.
    expect(await getTransfer('c-0')).toBeUndefined()
    expect(await getTransfer(`c-${total - 1}`)).toBeTruthy()
  })

  it('also reaps the chunk rows a failed IDB receive left behind', async () => {
    await saveTransfer(record('dead', 'failed', NOW - TERMINAL_RETENTION_MS - 1))
    await saveChunk('dead', 0, new Uint8Array([1, 2, 3]).buffer)
    await saveChunk('dead', 1, new Uint8Array([4]).buffer)
    // A live transfer's chunks must survive the sweep.
    await saveTransfer(record('alive', 'active', NOW))
    await saveChunk('alive', 0, new Uint8Array([9]).buffer)

    await pruneTerminalTransfers({ now: NOW })

    expect(await getChunk('dead', 0)).toBeUndefined()
    expect(await getChunk('dead', 1)).toBeUndefined()
    expect(await getChunk('alive', 0)).toBeTruthy()
  })

  it('honours explicit bounds so callers can force an aggressive sweep', async () => {
    for (let i = 0; i < 5; i++) await saveTransfer(record(`x-${i}`, 'completed', NOW - i))
    const removed = await pruneTerminalTransfers({ maxCount: 2, now: NOW })
    expect(removed).toBe(3)
  })

  it('is a cheap no-op when there is nothing to prune', async () => {
    await saveTransfer(record('only', 'completed', NOW))
    expect(await pruneTerminalTransfers({ now: NOW })).toBe(0)
  })
})
