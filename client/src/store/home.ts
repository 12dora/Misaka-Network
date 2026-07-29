import { create } from 'zustand'
import type { NetworkStats, ActivityEvent } from '@/types'
import { apiUrl } from '@/config'

const EMPTY_STATS: NetworkStats = {
  onlineNodes: 0,
  peakConcurrent: 0,
  totalTransfers: 0,
  totalBytes: 0,
  activeChannels: 0,
  uptimeLongestMs: 0,
  uptimeSeconds: 0,
  cpuLoadPercent: 0,
}

/**
 * Maximum activities retained in the home store after any add.
 * ActivityStream pause/flush must disclose this cap so the button count
 * never promises more history than the store will keep.
 */
export const ACTIVITY_HISTORY_CAP = 20

// BUG-030 — "实时服务状态" rendered failed and stale fetches as valid data.
//
// `fetchStats` swallowed every failure: a non-ok response or a thrown fetch
// left `stats` at whatever it was, and the dashboard happily labelled it
// live. On a first-load failure that meant a wall of confident zeros —
// "在线实验体数 0" reads as "the network is empty", not "we couldn't reach
// the server". On a later polling failure the last good numbers froze while
// still claiming to be real time.
//
// The store now models the fetch explicitly so the UI can distinguish
// never-loaded, loading, fresh, and stale-but-showing-last-known.

export type StatsStatus = 'idle' | 'loading' | 'ready' | 'error'

/** Data older than this is presented as possibly out of date (poll = 10 s). */
export const STATS_STALE_AFTER_MS = 30_000

export function isStatsStale(lastUpdated: number | null, now = Date.now()): boolean {
  if (lastUpdated === null) return false
  return now - lastUpdated > STATS_STALE_AFTER_MS
}

/** `数据更新于 HH:mm` — the timestamp shown alongside stale data. */
export function formatStatsTimestamp(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

interface HomeState {
  stats: NetworkStats
  activities: ActivityEvent[]
  statsLoading: boolean
  statsStatus: StatsStatus
  /** When the currently displayed numbers were successfully fetched. */
  statsLastUpdated: number | null
  /** True once at least one fetch has succeeded — gates "show last known". */
  statsHasData: boolean
  fetchStats: () => Promise<void>
  addActivity: (event: ActivityEvent) => void
}

// Monotonic request id so a slow old /api/stats response cannot overwrite a
// newer one (or clear statsLoading while a later fetch is still in flight).
let statsFetchSeq = 0

export const useHomeStore = create<HomeState>((set, get) => ({
  stats: EMPTY_STATS,
  activities: [],
  statsLoading: false,
  statsStatus: 'idle',
  statsLastUpdated: null,
  statsHasData: false,

  async fetchStats() {
    const seq = ++statsFetchSeq
    // Keep `statsStatus` at 'ready' during a background refresh so a poll
    // doesn't flash the skeleton over good data every 10 seconds.
    set({ statsLoading: true, statsStatus: get().statsHasData ? 'ready' : 'loading' })
    try {
      const res = await fetch(apiUrl('/api/stats'))
      if (seq !== statsFetchSeq) return
      if (res.ok) {
        const data = await res.json() as NetworkStats
        if (seq !== statsFetchSeq) return
        set({
          stats: data,
          statsStatus: 'ready',
          statsLastUpdated: Date.now(),
          statsHasData: true,
        })
      } else {
        // An HTTP error is a failure, not "zero activity".
        set({ statsStatus: 'error' })
      }
    } catch {
      if (seq !== statsFetchSeq) return
      set({ statsStatus: 'error' })
    } finally {
      // Only the latest request may clear loading — an older request finishing
      // while a newer one is in flight must leave the spinner alone.
      if (seq === statsFetchSeq) {
        set({ statsLoading: false })
      }
    }
  },

  addActivity(event) {
    set(state => ({
      activities: [event, ...state.activities].slice(0, ACTIVITY_HISTORY_CAP),
    }))
  },
}))
