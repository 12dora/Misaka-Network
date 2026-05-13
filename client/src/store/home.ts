import { create } from 'zustand'
import type { NetworkStats, ActivityEvent } from '@/types'
import { apiUrl } from '@/config'

const EMPTY_STATS: NetworkStats = {
  onlineNodes: 0,
  totalTransfers: 0,
  totalBytes: 0,
  activeChannels: 0,
  uptimeLongestMs: 0,
  cpuLoadPercent: 0,
}

interface HomeState {
  stats: NetworkStats
  activities: ActivityEvent[]
  statsLoading: boolean
  fetchStats: () => Promise<void>
  addActivity: (event: ActivityEvent) => void
}

export const useHomeStore = create<HomeState>((set) => ({
  stats: EMPTY_STATS,
  activities: [],
  statsLoading: false,

  async fetchStats() {
    set({ statsLoading: true })
    try {
      const res = await fetch(apiUrl('/api/stats'))
      if (res.ok) {
        const data = await res.json() as NetworkStats
        set({ stats: data })
      }
    } catch {
      // network not available yet — keep empty stats
    } finally {
      set({ statsLoading: false })
    }
  },

  addActivity(event) {
    set(state => ({
      activities: [event, ...state.activities].slice(0, 20),
    }))
  },
}))
