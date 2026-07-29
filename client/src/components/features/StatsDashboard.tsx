import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useHomeStore, isStatsStale, formatStatsTimestamp } from '@/store/home'
import MisakaCard from '@/components/ui/MisakaCard'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'
import { formatDurationZhCN, formatUptimeZhCN, common } from '@/copy/zh-CN/common'
import { stats as statsCopy } from '@/copy/zh-CN/stats'

function formatBytes(bytes: number) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

const STAT_CARDS = [
  { kanji: '同', key: 'onlineNodes',      format: (v: number) => v.toLocaleString(), ...statsCopy.cards.onlineDevices },
  { kanji: '峰', key: 'peakConcurrent',   format: (v: number) => v.toLocaleString(), ...statsCopy.cards.peakConcurrent },
  { kanji: '流', key: 'totalTransfers',   format: (v: number) => v.toLocaleString(), ...statsCopy.cards.totalTransfers },
  { kanji: '量', key: 'totalBytes',       format: (v: number) => formatBytes(v),     ...statsCopy.cards.totalBytes },
  { kanji: '链', key: 'activeChannels',   format: (v: number) => v.toLocaleString(), ...statsCopy.cards.activeChannels },
  { kanji: '稳', key: 'uptimeLongestMs',  format: (v: number) => formatDurationZhCN(v), ...statsCopy.cards.uptimeLongest },
  { kanji: '时', key: 'uptimeSeconds',    format: (v: number) => formatUptimeZhCN(v), ...statsCopy.cards.uptimeService },
] as const

export default function StatsDashboard() {
  const { stats, fetchStats, statsStatus, statsLastUpdated, statsHasData } = useHomeStore()
  const [visible, setVisible] = useState(false)
  const [animated, setAnimated] = useState(false)
  const [, setTick] = useState(0)
  const gridRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetchStats()
    const timer = setInterval(fetchStats, 10_000)
    const staleTimer = setInterval(() => setTick(t => t + 1), 10_000)
    return () => { clearInterval(timer); clearInterval(staleTimer) }
  }, [fetchStats])

  useLayoutEffect(() => {
    const el = gridRef.current
    if (!el) return

    const rect = el.getBoundingClientRect()
    if (rect.top < window.innerHeight && rect.bottom > 0) {
      setVisible(true)
      return
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true)
          setAnimated(true)
          observer.disconnect()
        }
      },
      { threshold: 0.1 }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const cpuPct = Math.max(0, Math.min(100, stats.cpuLoadPercent))
  const stale = isStatsStale(statsLastUpdated)
  const showSkeleton = !statsHasData && statsStatus !== 'error'
  const showFirstLoadError = !statsHasData && statsStatus === 'error'
  const showStaleNotice = statsHasData && (statsStatus === 'error' || stale)

  return (
    <section className="px-8 py-14">
      <div className="section-header">
        <div className="title-row">
          <MisakaKanjiBlock char="観" size="lg" />
          <h2>{statsCopy.sectionTitle}</h2>
        </div>
        <p className="furigana ml-[calc(2rem+0.6rem)]">
          {showStaleNotice || showFirstLoadError ? statsCopy.serviceStatus : statsCopy.liveStatus}
        </p>
        <div className="accent-line" />
      </div>

      {showFirstLoadError && (
        <MisakaCard padding="md" className="max-w-5xl mb-5">
          <div className="flex flex-wrap items-center justify-between gap-3" role="status">
            <span className="font-kanji text-sm" style={{ color: 'var(--state-warn-on-light)' }}>
              {statsCopy.fetchFailed}
            </span>
            <button className="nav-pill text-sm" onClick={() => { void fetchStats() }}>
              {statsCopy.retry}
            </button>
          </div>
        </MisakaCard>
      )}

      {showStaleNotice && statsLastUpdated !== null && (
        <p
          className="font-kanji text-xs mb-4 max-w-5xl"
          style={{ color: 'var(--state-warn-on-blue)' }}
          role="status"
        >
          {statsCopy.staleNotice(formatStatsTimestamp(statsLastUpdated))}
        </p>
      )}

      <div ref={gridRef} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 max-w-5xl">
        {STAT_CARDS.map((card, idx) => {
          const value = stats[card.key as keyof typeof stats] as number
          return (
            <MisakaCard
              key={card.kanji}
              padding="md"
              className="group hover:-translate-y-1 hover:shadow-float transition-transform duration-200 cursor-default"
              style={{
                opacity: !visible ? 0 : animated ? 0 : undefined,
                animation: animated ? `card-in 0.45s ease ${idx * 0.07}s forwards` : 'none',
              }}
            >
              <div className="flex items-start justify-between mb-3">
                <MisakaKanjiBlock char={card.kanji} size="sm" />
                <span className="font-kanji text-xs text-[var(--text-on-white-2)]">{card.hint}</span>
              </div>
              <div className="font-kanji font-bold text-4xl tabular-nums text-[var(--text-on-white)] transition-colors">
                {showSkeleton ? (
                  <span
                    className="skeleton-shimmer inline-block w-24 h-9 rounded align-middle"
                    style={{ background: 'var(--surface-tint)' }}
                    aria-label={common.loadingShort}
                    // Single status region for the whole skeleton grid is
                    // announced by the first card only (idx === 0).
                    role={idx === 0 ? 'status' : undefined}
                    aria-hidden={idx === 0 ? undefined : true}
                  />
                ) : showFirstLoadError ? (
                  <span className="text-2xl" style={{ color: 'var(--text-muted-on-light)' }}>—</span>
                ) : (
                  card.format(value)
                )}
              </div>
              {card.unit && (
                <div className="font-kanji text-sm text-[var(--text-on-white-2)] mt-1">{card.unit}</div>
              )}
              <div className="font-kanji text-xs text-[var(--text-on-white-2)] mt-2">{card.label}</div>
            </MisakaCard>
          )
        })}
      </div>

      <div className="mt-8 max-w-5xl">
        <div className="flex items-center gap-3 mb-2">
          <span className="font-kanji text-xs text-[var(--text-on-blue-2)]">{statsCopy.cpuLoad}</span>
          <span className="font-mono text-xs text-[var(--accent-cyan-on-blue)]">
            {statsHasData ? `${cpuPct}%` : '—'}
          </span>
        </div>
        <div
          className="relative overflow-hidden rounded-full"
          style={{ height: 6, background: 'rgba(255,255,255,0.15)' }}
          role="progressbar"
          aria-label={statsCopy.cpuLoad}
          aria-valuenow={statsHasData ? cpuPct : 0}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          {/* scaleX instead of width — compositor-friendly (08 P2). */}
          <div
            className="h-full rounded-full origin-left transition-transform duration-1000"
            style={{
              width: '100%',
              transform: `scaleX(${statsHasData ? cpuPct / 100 : 0})`,
              background: 'linear-gradient(90deg, var(--accent-cyan), #FFFFFF)',
            }}
          />
        </div>
      </div>
    </section>
  )
}
