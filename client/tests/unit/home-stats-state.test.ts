// BUG-030 — the "实时服务状态" dashboard rendered failed and stale fetches as
// valid data.
//
// `fetchStats` swallowed every failure: a non-ok response or a thrown fetch
// left `stats` untouched, and the section still claimed to be live. On a
// first-load failure that meant a wall of zeros — "在线实验体数 0" reads as
// "the network is empty", not "we could not reach the server". On a later
// polling failure the last good numbers froze under a real-time label.
//
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  useHomeStore, isStatsStale, formatStatsTimestamp, STATS_STALE_AFTER_MS,
} from '../../src/store/home'

const SAMPLE = {
  onlineNodes: 12,
  peakConcurrent: 40,
  totalTransfers: 7,
  totalBytes: 1024,
  activeChannels: 3,
  uptimeLongestMs: 1000,
  uptimeSeconds: 60,
  cpuLoadPercent: 5,
}

const realFetch = globalThis.fetch

function reset() {
  useHomeStore.setState({
    stats: {
      onlineNodes: 0, peakConcurrent: 0, totalTransfers: 0, totalBytes: 0,
      activeChannels: 0, uptimeLongestMs: 0, uptimeSeconds: 0, cpuLoadPercent: 0,
    },
    statsStatus: 'idle',
    statsLastUpdated: null,
    statsHasData: false,
    statsLoading: false,
  })
}

function mockFetch(impl: () => Promise<unknown>) {
  globalThis.fetch = vi.fn(impl) as unknown as typeof fetch
}

describe('BUG-030: stats fetch state machine', () => {
  beforeEach(reset)
  afterEach(() => { globalThis.fetch = realFetch })

  it('happy path — a successful fetch reaches ready with a timestamp', async () => {
    mockFetch(async () => ({ ok: true, json: async () => SAMPLE }))

    const before = Date.now()
    await useHomeStore.getState().fetchStats()
    const s = useHomeStore.getState()

    expect(s.statsStatus).toBe('ready')
    expect(s.statsHasData).toBe(true)
    expect(s.stats.onlineNodes).toBe(12)
    expect(s.statsLastUpdated).not.toBeNull()
    expect(s.statsLastUpdated as number).toBeGreaterThanOrEqual(before)
    expect(s.statsLoading).toBe(false)
  })

  it('REGRESSION — a first-load network failure is `error`, not zeros-as-data', async () => {
    mockFetch(async () => { throw new Error('offline') })

    await useHomeStore.getState().fetchStats()
    const s = useHomeStore.getState()

    expect(s.statsStatus).toBe('error')
    // The critical bit: nothing tells the UI it may present these numbers.
    expect(s.statsHasData).toBe(false)
    expect(s.statsLastUpdated).toBeNull()
  })

  it('REGRESSION — an HTTP error is a failure, not "zero activity"', async () => {
    mockFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }))

    await useHomeStore.getState().fetchStats()

    expect(useHomeStore.getState().statsStatus).toBe('error')
    expect(useHomeStore.getState().statsHasData).toBe(false)
  })

  it('EDGE — a failing poll keeps the last good numbers but flips to error', async () => {
    mockFetch(async () => ({ ok: true, json: async () => SAMPLE }))
    await useHomeStore.getState().fetchStats()
    const goodAt = useHomeStore.getState().statsLastUpdated

    mockFetch(async () => { throw new Error('blip') })
    await useHomeStore.getState().fetchStats()
    const s = useHomeStore.getState()

    expect(s.statsStatus).toBe('error')
    expect(s.stats.onlineNodes).toBe(12)     // last known is retained…
    expect(s.statsHasData).toBe(true)        // …and flagged as showable…
    expect(s.statsLastUpdated).toBe(goodAt)  // …with its original timestamp.
  })

  it('EDGE — a background refresh does not flash the skeleton over good data', async () => {
    mockFetch(async () => ({ ok: true, json: async () => SAMPLE }))
    await useHomeStore.getState().fetchStats()

    let statusDuringRefresh: string | undefined
    mockFetch(async () => {
      statusDuringRefresh = useHomeStore.getState().statsStatus
      return { ok: true, json: async () => SAMPLE }
    })
    await useHomeStore.getState().fetchStats()

    expect(statusDuringRefresh).toBe('ready')
  })

  it('the very first fetch does report `loading`', async () => {
    let statusDuringFirst: string | undefined
    mockFetch(async () => {
      statusDuringFirst = useHomeStore.getState().statsStatus
      return { ok: true, json: async () => SAMPLE }
    })
    await useHomeStore.getState().fetchStats()

    expect(statusDuringFirst).toBe('loading')
  })
})

describe('BUG-030: staleness helpers', () => {
  it('never-loaded data is not "stale"', () => {
    expect(isStatsStale(null)).toBe(false)
  })

  it('fresh data is not stale, data past the window is', () => {
    const now = 1_000_000
    expect(isStatsStale(now - 1_000, now)).toBe(false)
    expect(isStatsStale(now - STATS_STALE_AFTER_MS, now)).toBe(false)
    expect(isStatsStale(now - STATS_STALE_AFTER_MS - 1, now)).toBe(true)
  })

  it('formats the timestamp as the prescribed HH:mm', () => {
    const d = new Date(2026, 6, 27, 9, 5, 0)
    expect(formatStatsTimestamp(d.getTime())).toBe('09:05')
    const d2 = new Date(2026, 6, 27, 23, 59, 0)
    expect(formatStatsTimestamp(d2.getTime())).toBe('23:59')
  })
})
