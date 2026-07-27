import { useId, useState } from 'react'
import MisakaCard from '@/components/ui/MisakaCard'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'
import MisakaButton from '@/components/ui/MisakaButton'
import AppFooter from '@/components/ui/AppFooter'
import MisakaHeroTitle from '@/components/ui/MisakaHeroTitle'
import { QUOTES, CHARACTERS, LORE_LOG, LORE_TIMELINE, getCharacterByNodeId } from '@/data/lore'
import { publicAssetUrl } from '@/lib/appBase'
import { scrollIntoViewSafely, useCoarsePointer, useReducedMotion } from '@/hooks/useReducedMotion'

const HERO_CHARACTER = publicAssetUrl('assets/misaka.webp')

// ── Section Header ────────────────────────────────────────────────
function SectionHeader({ kanji, title, furigana }: { kanji: string; title: string; furigana: string }) {
  return (
    <div className="section-header mb-10">
      <div className="title-row">
        <MisakaKanjiBlock char={kanji} size="lg" />
        <h2>{title}</h2>
      </div>
      <p className="furigana">{furigana}</p>
      <div className="accent-line" />
    </div>
  )
}

// ── Characters Section ────────────────────────────────────────────
function CharacterSection() {
  return (
    <section id="characters" className="px-5 md:px-8 py-14 scroll-mt-20">
      <SectionHeader kanji="体" title="实验体档案" furigana="実験体ファイル" />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-3xl">
        {CHARACTERS.map(c => (
          <MisakaCard
            key={c.nodeId}
            padding="none"
            className="overflow-hidden hover:-translate-y-1 transition-all duration-200"
          >
            <div
              className="h-36 flex items-center justify-center relative"
              style={{ background: 'linear-gradient(180deg, var(--bg-soft), var(--bg-primary))' }}
            >
              <MisakaKanjiBlock char={c.kanji} size="xl" className="opacity-80" />
              <div className="absolute bottom-3 right-4 font-jp text-xs text-[var(--text-on-blue-2)]">
                {c.furigana}
              </div>
            </div>
            <div className="p-5">
              <div className="flex items-center gap-2 mb-2">
                <MisakaKanjiBlock char={c.kanji} size="sm" />
                <span className="font-kanji font-bold text-base text-[var(--text-on-white)]">{c.name}</span>
              </div>
              <div
                className="inline-block font-kanji text-xs px-2 py-0.5 rounded mb-3"
                style={{ background: 'var(--surface-tint)', color: 'var(--bg-deep)' }}
              >
                {c.title}
              </div>
              <p className="font-kanji text-xs text-[var(--text-on-white-2)] leading-relaxed">{c.desc}</p>
              {c.quote && (
                <p
                  className="font-jp text-sm text-[var(--text-on-white)] mt-3 leading-relaxed border-l-2 pl-3"
                  style={{ borderColor: 'var(--accent-cyan)' }}
                >
                  「{c.quote}」
                </p>
              )}
            </div>
          </MisakaCard>
        ))}
      </div>
    </section>
  )
}

// ── Easter Eggs Section ───────────────────────────────────────────
function EasterEggSection() {
  const [quote, setQuote] = useState(QUOTES[0])
  const [nodeQuery, setNodeQuery] = useState('')
  const [queryResult, setQueryResult] = useState<string | null>(null)
  const [queryError, setQueryError] = useState(false)
  const nodeQueryId = useId()
  // A11Y-008 / UX-MOTION-001: the lore log drifts forever and could only be
  // paused by hovering — unreachable for keyboard and touch users. Coarse
  // pointers and reduced-motion users start paused; everyone gets an
  // explicit control.
  const reducedMotion = useReducedMotion()
  const coarsePointer = useCoarsePointer()
  const [lorePaused, setLorePaused] = useState(false)
  const loreStopped = lorePaused || reducedMotion || coarsePointer

  function randomQuote() {
    const idx  = Math.floor(Math.random() * QUOTES.length)
    setQuote(QUOTES[idx])
  }

  function queryNode() {
    const n = parseInt(nodeQuery, 10)
    if (isNaN(n) || n < 1 || n > 20001) {
      setQueryError(true)
      setQueryResult('节点编号范围为 1~20001')
      return
    }
    setQueryError(false)
    setQueryResult(getCharacterByNodeId(n))
  }

  return (
    <section id="easter-eggs" className="px-5 md:px-8 py-14 scroll-mt-20">
      <SectionHeader kanji="戯" title="彩蛋功能" furigana="おまけ機能" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl">

        {/* Quote Generator */}
        <MisakaCard padding="md" className="flex flex-col">
          <div className="flex items-center gap-2 mb-4">
            <MisakaKanjiBlock char="語" size="sm" />
            <span className="font-kanji font-bold text-sm text-[var(--text-on-white)]">妹妹语录生成器</span>
          </div>
          <div className="flex-1 flex items-center justify-center py-4">
            <p className="font-jp text-lg text-[var(--text-on-white)] leading-loose text-center">
              「{quote}」
            </p>
          </div>
          <MisakaButton variant="pill" size="sm" fullWidth onClick={randomQuote}>
            ↻ 重新生成
          </MisakaButton>
        </MisakaCard>

        {/* Node ID Query */}
        <MisakaCard padding="md" className="flex flex-col">
          <div className="flex items-center gap-2 mb-4">
            <MisakaKanjiBlock char="号" size="sm" />
            <span className="font-kanji font-bold text-sm text-[var(--text-on-white)]">实验体编号查询</span>
          </div>
          {/* A11Y-004: a placeholder is not a label. */}
          <label htmlFor={nodeQueryId} className="block font-kanji text-xs text-[var(--text-on-white-2)] mb-1.5">
            实验体编号，范围 1–20001
          </label>
          {/* UX-LAYOUT-005: a `flex-1` number input keeps its intrinsic
              min-content width unless `min-width: 0` is set, so in a narrow
              three-column card the input + 查询 button overflowed the card.
              `min-w-0` lets it actually shrink, and `flex-wrap` gives the
              button its own line before anything is clipped. */}
          <div className="flex flex-wrap gap-2 mb-4">
            <input
              id={nodeQueryId}
              type="number"
              min={1}
              max={20001}
              inputMode="numeric"
              placeholder="1~20001"
              value={nodeQuery}
              onChange={e => { setNodeQuery(e.target.value); setQueryError(false) }}
              onKeyDown={e => e.key === 'Enter' && queryNode()}
              aria-invalid={queryError || undefined}
              aria-describedby={queryResult ? `${nodeQueryId}-result` : undefined}
              // A11Y-005: `focus:outline-none` removed the ONLY focus
              // indicator on this input. Keep it (the platform ring clashes
              // with the card style) but reinstate the shared ring.
              className="misaka-focus-ring flex-1 min-w-0 px-3 py-2 rounded-lg text-sm font-mono focus:outline-none"
              style={{ border: '1px solid var(--border-card)', background: 'var(--surface)', color: 'var(--text-on-white)' }}
            />
            <MisakaButton variant="primary" size="sm" className="shrink-0" onClick={queryNode}>查询</MisakaButton>
          </div>
          {queryResult && (
            <div
              id={`${nodeQueryId}-result`}
              role="status"
              className="rounded-lg p-3 font-kanji text-xs leading-relaxed"
              style={{
                background: 'var(--surface-tint)',
                whiteSpace: 'pre-wrap',
                color: queryError ? 'var(--state-warn-on-light)' : 'var(--text-on-white)',
              }}
            >
              {queryResult}
            </div>
          )}
        </MisakaCard>

        {/* Lore Log */}
        <MisakaCard padding="md" className="flex flex-col">
          <div className="flex items-center justify-between gap-2 mb-4">
            <div className="flex items-center gap-2 min-w-0">
              <MisakaKanjiBlock char="録" size="sm" />
              <span className="font-kanji font-bold text-sm text-[var(--text-on-white)]">网络日志</span>
            </div>
            {/* A11Y-008: keyboard- and touch-reachable pause. Hidden when
                motion is already off, so we never offer a control that
                does nothing. */}
            {!reducedMotion && !coarsePointer && (
              <MisakaButton
                variant="pill"
                size="sm"
                className="text-[11px] py-1 px-2 shrink-0"
                aria-pressed={lorePaused}
                onClick={() => setLorePaused(p => !p)}
              >
                {lorePaused ? '▶ 继续滚动' : '⏸ 暂停滚动'}
              </MisakaButton>
            )}
          </div>
          <div
            className="lore-log flex flex-col gap-2 overflow-y-auto"
            data-paused={loreStopped ? 'true' : 'false'}
            style={{ maxHeight: 200 }}
          >
            {LORE_LOG.map((entry, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <span
                  className="mt-1.5 flex-shrink-0 inline-block w-1.5 h-1.5 rounded-full"
                  style={{ background: 'var(--accent-cyan)' }}
                />
                <span className="font-mono text-[var(--text-on-white-2)] flex-shrink-0">{entry.date}</span>
                <span className="font-kanji text-[var(--text-on-white)]">{entry.event}</span>
              </div>
            ))}
          </div>
        </MisakaCard>
      </div>
    </section>
  )
}

// ── Timeline Section ──────────────────────────────────────────────
function TimelineSection() {
  return (
    <section id="timeline" className="px-5 md:px-8 py-14 scroll-mt-20">
      <SectionHeader kanji="史" title="世界观时间线" furigana="タイムライン" />
      <div className="max-w-4xl grid grid-cols-1 md:grid-cols-2 gap-5">
        {LORE_TIMELINE.map(item => (
          <MisakaCard key={item.title} padding="md">
            <div className="font-mono text-xs text-[var(--accent-cyan)] mb-2">{item.date}</div>
            <h3 className="font-kanji font-bold text-base text-[var(--text-on-white)] mb-2">{item.title}</h3>
            <p className="font-kanji text-sm leading-relaxed text-[var(--text-on-white-2)]">{item.body}</p>
          </MisakaCard>
        ))}
      </div>
    </section>
  )
}

// ── Page ──────────────────────────────────────────────────────────
export default function ACGN() {
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-primary)' }}>

      {/* ── Mobile Hero ───────────────────────────────────────────── */}
      <section className="md:hidden relative overflow-hidden pt-nav">
        <div
          className="absolute inset-0 pointer-events-none dot-grid"
          style={{
            opacity: 0.5,
            maskImage: 'linear-gradient(to bottom, #000 0%, transparent 72%)',
            WebkitMaskImage: 'linear-gradient(to bottom, #000 0%, transparent 72%)',
          }}
        />

        <div
          className="hero-stage relative w-full overflow-hidden"
          style={{
            background: 'linear-gradient(180deg, rgba(14,42,107,0.18) 0%, rgba(255,255,255,0.08) 100%)',
          }}
        >
          <div
            className="absolute inset-x-0 bottom-0 pointer-events-none"
            style={{
              height: '38%',
              background: 'linear-gradient(to top, var(--bg-primary) 0%, rgba(26,79,196,0.72) 44%, transparent 100%)',
              zIndex: 2,
            }}
          />
          <div
            className="absolute left-1/2 bottom-3 h-8 w-[68vw] max-w-[320px] -translate-x-1/2 rounded-[50%] pointer-events-none"
            style={{
              background: 'rgba(14,42,107,0.22)',
              filter: 'blur(14px)',
              zIndex: 1,
            }}
          />
          <img
            src={HERO_CHARACTER}
            alt="御坂美琴"
            className="animate-float select-none pointer-events-none"
            loading="eager"
            fetchPriority="high"
            decoding="async"
            style={{
              position: 'absolute',
              bottom: 10,
              left: '50%',
              height: 'min(calc(100% - 18px), clamp(290px, 46svh, 390px))',
              maxWidth: '82vw',
              objectFit: 'contain',
              objectPosition: 'bottom center',
              transform: 'translateX(-50%)',
              ['--float-x' as string]: '-50%',
              zIndex: 1,
            }}
            draggable={false}
          />
        </div>

        <div className="relative z-10 flex flex-col items-center px-5 -mt-8 pb-10 gap-4">
          <MisakaHeroTitle width="min(230px, 62vw)" />
          <p className="font-jp text-sm text-[var(--text-on-blue-2)] text-center leading-loose">
            连接全部御坂妹妹的脑量子波共享网络<br />
            <span className="text-xs">全ての御坂妹妹を繋ぐ脳量子波ネットワーク</span>
          </p>
          <MisakaButton
            variant="pill"
            size="sm"
            onClick={() => scrollIntoViewSafely(document.getElementById('about'))}
          >
            了解更多
          </MisakaButton>
        </div>
      </section>

      {/* ── Desktop Hero (44/56) ──────────────────────────────────── */}
      <section
        className="relative hidden md:grid overflow-hidden"
        style={{
          gridTemplateColumns: '44% 1fr',
          minHeight: 'min(80vh, 680px)',
          paddingTop: 'var(--nav-h-total)',
        }}
      >
        <div className="relative flex items-end justify-center">
          <img
            src={HERO_CHARACTER}
            alt="御坂美琴"
            className="animate-float select-none pointer-events-none"
            loading="eager"
            fetchPriority="high"
            decoding="async"
            style={{
              maxHeight: 'calc(min(100dvh, 820px) - var(--nav-h-total))',
              width: '100%',
              objectFit: 'contain',
              objectPosition: 'bottom center',
            }}
            draggable={false}
          />
        </div>
        <div
          className="flex flex-col justify-center pr-12 pl-8 gap-6 relative z-10"
          style={{ paddingBottom: '3rem', paddingTop: '2rem' }}
        >
          <MisakaHeroTitle width="clamp(280px, 32vw, 460px)" />
          <p className="font-jp text-lg text-[var(--text-on-blue)] leading-loose">
            连接全部御坂妹妹的脑量子波共享网络<br />
            <span className="text-sm text-[var(--text-on-blue-2)]">全ての御坂妹妹を繋ぐ脳量子波ネットワーク</span>
          </p>
          <div className="flex gap-3">
            <MisakaButton
              variant="pill"
              size="sm"
              onClick={() => scrollIntoViewSafely(document.getElementById('about'))}
            >
              了解更多
            </MisakaButton>
          </div>
        </div>
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            left: '44%',
            backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.06) 1px, transparent 1px)',
            backgroundSize: '24px 24px',
          }}
        />
      </section>

      {/* ── About ────────────────────────────────────────────────── */}
      <section id="about" className="px-5 md:px-8 py-14 scroll-mt-20">
        <SectionHeader kanji="設" title="关于御坂网络" furigana="みさかネットワークについて" />
        <MisakaCard padding="lg" className="max-w-3xl">
          <div className="font-kanji text-base text-[var(--text-on-white)] leading-[1.85] space-y-4">
            <p>
              <strong style={{ color: 'var(--bg-deep)' }}>御坂网络</strong>是连接全部御坂妹妹的
              <span style={{ color: 'var(--accent-cyan)' }}>脑量子波</span>
              共享网络。
            </p>
            <p>
              在《某科学的超电磁炮》设定中，约 20,000 名
              <span style={{ color: 'var(--accent-cyan)' }}>实验体</span>
              通过脑量子波互联，形成
              <span style={{ color: 'var(--accent-cyan)' }}>分布式</span>
              意识网络。每个妹妹既是独立个体，又能共享视觉、记忆、知识。
            </p>
            <p>
              本 APP 借用这一设定作为美学骨架，构建 P2P 文件传输工具：每位用户都是一个「节点」，节点之间通过加密信道直接共享数据——文件本体永不经过服务器。
            </p>
          </div>
        </MisakaCard>
      </section>

      <CharacterSection />
      <EasterEggSection />
      <TimelineSection />

      {/* ── Footer ───────────────────────────────────────────────── */}
      <AppFooter id="credits" />
    </div>
  )
}
