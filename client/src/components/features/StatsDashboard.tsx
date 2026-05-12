import { useEffect, useRef, useState } from 'react'
import { useHomeStore } from '@/store/home'
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

const STAT_CARDS = [
  { kanji: '同', label: '在线实验体数',     furigana: 'オンライン数',   key: 'onlineNodes',      format: (v: number) => v.toLocaleString(),    unit: '节点' },
  { kanji: '流', label: '累计脑波同步次数', furigana: '累計シンクロ数', key: 'totalTransfers',   format: (v: number) => v.toLocaleString(),    unit: '次' },
  { kanji: '量', label: '累计数据通量',     furigana: '累積データ量',   key: 'totalBytes',       format: (v: number) => formatBytes(v),        unit: '' },
  { kanji: '链', label: '当前活跃信道',     furigana: '活性チャンネル', key: 'activeChannels',   format: (v: number) => v.toLocaleString(),    unit: '条' },
  { kanji: '域', label: '节点覆盖区域',     furigana: 'ノードカバー範囲', key: 'onlineNodes',    format: (v: number) => Math.min(v, 30).toString(), unit: '区域' },
  { kanji: '稳', label: '最长稳定时长',     furigana: '最長稼働時間',   key: 'uptimeLongestMs', format: (v: number) => formatDuration(v),      unit: '' },
]

export default function StatsDashboard() {
  const { stats, fetchStats } = useHomeStore()
  const [visible, setVisible] = useState(false)
  const gridRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetchStats()
    const timer = setInterval(fetchStats, 10_000)
    return () => clearInterval(timer)
  }, [fetchStats])

  useEffect(() => {
    const el = gridRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setVisible(true); observer.disconnect() } },
      { threshold: 0.1 }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const cpuPct = Math.max(0, Math.min(100, stats.cpuLoadPercent))

  return (
    <section className="px-8 py-14">
      {/* Section Header */}
      <div className="section-header">
        <div className="title-row">
          <MisakaKanjiBlock char="観" size="lg" />
          <h2>网络运行情报</h2>
        </div>
        <p className="furigana ml-[calc(2rem+0.6rem)]">ネットワーク観測</p>
        <div className="accent-line" />
      </div>

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
                opacity: visible ? undefined : 0,
                animation: visible ? `card-in 0.45s ease ${idx * 0.07}s forwards` : 'none',
              }}
            >
              <div className="flex items-start justify-between mb-3">
                <MisakaKanjiBlock char={card.kanji} size="sm" />
                <span className="font-jp text-xs text-[var(--text-on-white-2)]">{card.furigana}</span>
              </div>
              <div className="font-kanji font-bold text-4xl tabular-nums text-[var(--text-on-white)] group-hover:text-[var(--accent-cyan)] transition-colors">
                {card.format(value)}
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
          <span className="font-mono text-xs text-[var(--accent-cyan)]">{cpuPct}%</span>
        </div>
        <div
          className="relative overflow-hidden rounded-full"
          style={{ height: 6, background: 'rgba(255,255,255,0.15)' }}
        >
          <div
            className="h-full rounded-full transition-all duration-1000"
            style={{
              width: `${cpuPct}%`,
              background: 'linear-gradient(90deg, var(--accent-cyan), #FFFFFF)',
            }}
          />
        </div>
      </div>
    </section>
  )
}
