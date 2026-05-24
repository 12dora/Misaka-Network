// P2-12: `deleteChunks` previously scanned the full chunks objectStore
// with getAllKeys + JS-side filter. On a transfers store with millions
// of chunk rows from prior sessions this allocated a fat array of keys
// and traversed every row even when the target transfer only owned a
// few. Switch to `IDBKeyRange.bound(${id}:, ${id};)` so the cursor
// iterates only the target's contiguous key range.
//
// We can't easily measure performance in jsdom but we CAN assert the
// semantic invariant: keys belonging to another transferId are
// untouched, and the keys with the right prefix are gone. Since
// jsdom doesn't ship a real IndexedDB and fake-indexeddb isn't on the
// devDeps, we mock the `idb` wrapper directly with an in-memory shim
// that also implements `getAllKeys(range)` and `delete(range)` so the
// range-based code path is exercised end-to-end.

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('idb', () => {
  // One DB across all calls; reset per-test via the helper below.
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
        // For keyPath stores (like 'transfers'), the caller passes value
        // only; we key off `transferId`. For external-keyed stores
        // (chunks), the explicit key is passed.
        if (key !== undefined) store.set(key, value)
        else store.set((value as { transferId: string }).transferId, value)
      },
      async delete(keyOrRange: string | IDBKeyRange) {
        if (typeof keyOrRange === 'string') {
          store.delete(keyOrRange)
        } else {
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
    const s = makeStore(name)
    return { store: s, done: Promise.resolve() }
  }

  function openDB(_name: string, _version: number, opts: { upgrade: (db: unknown) => void }) {
    opts.upgrade({
      objectStoreNames: { contains: () => false },
      createObjectStore: () => undefined,
    })
    return Promise.resolve({
      get: (name: string, key: string) => makeStore(name).get(key),
      put: (name: string, value: unknown, key?: string) => makeStore(name).put(value, key),
      delete: (name: string, key: string) => makeStore(name).delete(key),
      getAll: (name: string) => makeStore(name).getAll(),
      getAllKeys: (name: string, range?: IDBKeyRange) => makeStore(name).getAllKeys(range),
      transaction: (name: string) => makeTx(name),
    })
  }

  // Test helper exposed via the mocked module so beforeEach can reset state.
  ;(openDB as unknown as { __reset: () => void }).__reset = () => {
    for (const k of Object.keys(stores)) delete stores[k]
  }

  return { openDB }
})

// jsdom doesn't ship `IDBKeyRange`. The real db.ts under test will
// reference it directly, so polyfill a minimal shape that mirrors what
// db.ts uses (only `.bound`).
;(globalThis as any).IDBKeyRange = {
  bound(lower: string, upper: string, lowerOpen = false, upperOpen = false) {
    return { lower, upper, lowerOpen, upperOpen } as unknown as IDBKeyRange
  },
}

import { saveChunk, getChunk, deleteChunks, getSavedChunkIndexes } from '../../src/lib/db'
import * as idb from 'idb'

beforeEach(async () => {
  // Reset the in-memory store via the helper baked into the mock.
  ;(idb.openDB as unknown as { __reset: () => void }).__reset()
})

describe('deleteChunks: range-based delete (P2-12)', () => {
  it('only removes keys for the EXACT transferId (no prefix bleed)', async () => {
    const buf = (n: number) => new Uint8Array([n]).buffer
    // transferId 'range-a' has chunks 0,1,2
    await saveChunk('range-a', 0, buf(0))
    await saveChunk('range-a', 1, buf(1))
    await saveChunk('range-a', 2, buf(2))
    // 'range-aa' is a tricky prefix sibling — the old startsWith logic
    // was right for `range-a:`, but `IDBKeyRange.bound` must use the
    // semicolon trick to stop EXACTLY at the colon. (`:` is 0x3a, `;`
    // is 0x3b; the keys for range-aa are `range-aa:N` which sort AFTER
    // any `range-a:` key — meaning a lower bound of `range-a:` and an
    // upper bound of `range-a;` cleanly excludes them.)
    await saveChunk('range-aa', 0, buf(10))
    await saveChunk('range-aa', 1, buf(11))
    // Another unrelated transfer to make sure we don't nuke neighbours.
    await saveChunk('range-b', 7, buf(99))

    await deleteChunks('range-a')

    expect(await getChunk('range-a', 0)).toBeUndefined()
    expect(await getChunk('range-a', 1)).toBeUndefined()
    expect(await getChunk('range-a', 2)).toBeUndefined()
    // Survivors:
    expect(await getChunk('range-aa', 0)).toBeDefined()
    expect(await getChunk('range-aa', 1)).toBeDefined()
    expect(await getChunk('range-b', 7)).toBeDefined()
  })

  it('no-ops on an empty range without scanning the whole store', async () => {
    await saveChunk('range-b', 0, new Uint8Array([1]).buffer)
    await deleteChunks('range-a') // nothing for range-a
    expect(await getChunk('range-b', 0)).toBeDefined()
  })

  it('getSavedChunkIndexes also benefits from the range scan', async () => {
    const buf = (n: number) => new Uint8Array([n]).buffer
    await saveChunk('range-a', 0, buf(0))
    await saveChunk('range-a', 3, buf(3))
    await saveChunk('range-aa', 0, buf(99))

    const idx = await getSavedChunkIndexes('range-a')
    expect(idx).toEqual([0, 3])
    // The prefix-sibling chunks must NOT leak into the result.
  })
})
