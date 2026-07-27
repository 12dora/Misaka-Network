import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useHomeStore, isStatsStale, formatStatsTimestamp } from '@/store/home'
import MisakaCard from '@/components/ui/MisakaCard'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'

function formatBytes(bytes: number) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

function formatDuration(ms: number) {
  if (ms === 0) return '—'
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  return `${h}h ${m}m`
}

function formatUptime(sec: number) {
  if (sec === 0) return '—'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  if (d > 0) return `${d}d ${h}h`
  const m = Math.floor((sec % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

const STAT_CARDS = [
  { kanji: '同', label: '在线实验体数',     hint: '当前在线节点', key: 'onlineNodes',      format: (v: number) => v.toLocaleString(),    unit: '节点' },
  { kanji: '峰', label: '峰值并发连接',     hint: '历史最高在线', key: 'peakConcurrent',   format: (v: number) => v.toLocaleString(),    unit: '节点' },
  { kanji: '流', label: '累计脑波同步次数', hint: '累计传输次数', key: 'totalTransfers',   format: (v: number) => v.toLocaleString(),    unit: '次' },
  { kanji: '量', label: '累计数据通量',     hint: '累计传输体量', key: 'totalBytes',       format: (v: number) => formatBytes(v),        unit: '' },
  { kanji: '链', label: '当前活跃信道',     hint: '正在连接的信道', key: 'activeChannels',   format: (v: number) => v.toLocaleString(),    unit: '条' },
  { kanji: '稳', label: '最长节点在线',     hint: '最长在线时长', key: 'uptimeLongestMs', format: (v: number) => formatDuration(v),      unit: '' },
  { kanji: '时', label: '信令服务运行时间', hint: '服务运行时长', key: 'uptimeSeconds',  format: (v: number) => formatUptime(v),        unit: '' },
]

export default function StatsDashboard() {
  const { stats, fetchStats, statsStatus, statsLastUpdated, statsHasData } = useHomeStore()
  const [visible, setVisible] = useState(false)
  const [animated, setAnimated] = useState(false)
  // BUG-030: re-render on a timer so "数据更新于 HH:mm" flips to the stale
  // notice without waiting for the next successful poll.
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
      // Already in viewport — show immediately, no entrance animation
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

  // BUG-030: the four presentation states. `showSkeleton` covers both the
  // first load and a first load that failed — in neither case do we have
  // numbers, and printing zeros would read as "the network is empty".
  const stale = isStatsStale(statsLastUpdated)
  const showSkeleton = !statsHasData && statsStatus !== 'error'
  const showFirstLoadError = !statsHasData && statsStatus === 'error'
  const showStaleNotice = statsHasData && (statsStatus === 'error' || stale)

  return (
    <section className="px-8 py-14">
      {/* Section Header */}
      <div className="section-header">
        <div className="title-row">
          <MisakaKanjiBlock char="観" size="lg" />
          <h2>网络运行情报</h2>
        </div>
        <p className="furigana ml-[calc(2rem+0.6rem)]">
          {showStaleNotice || showFirstLoadError ? '服务状态' : '实时服务状态'}
        </p>
        <div className="accent-line" />
      </div>

      {/* BUG-030: an explicit failure state with a retry, instead of a grid
          of confident zeros. */}
      {showFirstLoadError && (
        <MisakaCard padding="md" className="max-w-5xl mb-5">
          <div className="flex flex-wrap items-center justify-between gap-3" role="status">
            <span className="font-kanji text-sm" style={{ color: 'var(--state-warn-on-light)' }}>
              暂时无法获取服务状态
            </span>
            <button className="nav-pill text-sm" onClick={() => { void fetchStats() }}>
              重试
            </button>
          </div>
        </MisakaCard>
      )}

      {/* Last-known data that is no longer live. */}
      {showStaleNotice && statsLastUpdated !== null && (
        <p
          className="font-kanji text-xs mb-4 max-w-5xl"
          style={{ color: 'var(--state-warn-on-blue)' }}
          role="status"
        >
          数据更新于 {formatStatsTimestamp(statsLastUpdated)}，当前可能已过期
        </p>
      )}

      {/* Stats Grid */}
      <div ref={gridRef} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 max-w-5xl">
        {STAT_CARDS.map((card, idx) => {
          const value = stats[card.key as keyof typeof stats] as number
          return (
            <MisakaCard
              key={card.kanji}
              padding="md"
              className="group hover:-translate-y-1 hover:shadow-float transition-all duration-200 cursor-default"
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
                    className="inline-block w-24 h-9 rounded align-middle"
                    style={{ background: 'var(--surface-tint)' }}
                    aria-label="加载中"
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

      {/* CPU Load Bar */}
      <div className="mt-8 max-w-5xl">
        <div className="flex items-center gap-3 mb-2">
          <span className="font-kanji text-xs text-[var(--text-on-blue-2)]">树形图运算负荷</span>
          <span className="font-mono text-xs text-[var(--accent-cyan-on-blue)]">
            {statsHasData ? `${cpuPct}%` : '—'}
          </span>
        </div>
        <div
          className="relative overflow-hidden rounded-full"
          style={{ height: 6, background: 'rgba(255,255,255,0.15)' }}
        >
          <div
            className="h-full rounded-full transition-all duration-1000"
            style={{
              width: statsHasData ? `${cpuPct}%` : '0%',
              background: 'linear-gradient(90deg, var(--accent-cyan), #FFFFFF)',
            }}
          />
        </div>
      </div>
    </section>
  )
}
