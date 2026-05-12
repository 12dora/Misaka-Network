import { useState } from 'react'
import MisakaCard from '@/components/ui/MisakaCard'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'
import MisakaButton from '@/components/ui/MisakaButton'
import { QUOTES, CHARACTERS, LORE_LOG, getCharacterByNodeId } from '@/data/lore'

const HERO_CHARACTER = '/assets/misaka.webp'
const HERO_TITLE     = '/assets/misaka-title.webp'

// ── Section Header ────────────────────────────────────────────────
function SectionHeader({ kanji, title, furigana }: { kanji: string; title: string; furigana: string }) {
  return (
    <div className="section-header mb-10">
      <div className="title-row">
        <MisakaKanjiBlock char={kanji} size="lg" />
        <h2>{title}</h2>
      </div>
      <p className="furigana ml-[calc(2rem+0.6rem)]">{furigana}</p>
      <div className="accent-line" />
    </div>
  )
}

// ── Characters Section ────────────────────────────────────────────
function CharacterSection() {
  return (
    <section id="characters" className="px-8 py-14">
      <SectionHeader kanji="体" title="实验体档案" furigana="実験体ファイル" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-3xl">
        {CHARACTERS.map(c => (
          <MisakaCard key={c.nodeId} padding="none" className="overflow-hidden hover:-translate-y-1 hover:shadow-float transition-all duration-200">
            {/* Illustration area */}
            <div
              className="h-40 flex items-center justify-center relative"
              style={{
                background: 'linear-gradient(180deg, var(--bg-soft), var(--bg-primary))',
              }}
            >
              <MisakaKanjiBlock char={c.kanji} size="xl" className="opacity-80" />
              <div className="absolute bottom-3 right-4 font-jp text-xs text-[var(--text-on-blue-2)]">
                {c.furigana}
              </div>
            </div>
            {/* Info */}
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
                <p className="font-jp text-sm text-[var(--text-on-white)] mt-3 leading-relaxed border-l-2 pl-3" style={{ borderColor: 'var(--accent-cyan)' }}>
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

  function randomQuote() {
    const next = QUOTES[Math.floor(Math.random() * QUOTES.length)]
    setQuote(next)
  }

  function queryNode() {
    const n = parseInt(nodeQuery, 10)
    if (isNaN(n) || n < 1 || n > 20001) {
      setQueryResult('节点编号范围为 1~20001')
      return
    }
    setQueryResult(getCharacterByNodeId(n))
  }

  return (
    <section id="easter-eggs" className="px-8 py-14">
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
          <div className="flex gap-2 mb-4">
            <input
              type="number"
              min={1}
              max={20001}
              placeholder="1~20001"
              value={nodeQuery}
              onChange={e => setNodeQuery(e.target.value)}
              className="flex-1 px-3 py-2 rounded-lg text-sm font-mono focus:outline-none"
              style={{ border: '1px solid var(--border-card)', background: 'var(--surface)', color: 'var(--text-on-white)' }}
            />
            <MisakaButton variant="primary" size="sm" onClick={queryNode}>查询</MisakaButton>
          </div>
          {queryResult && (
            <div
              className="rounded-lg p-3 font-kanji text-xs text-[var(--text-on-white)] leading-relaxed"
              style={{ background: 'var(--surface-tint)' }}
            >
              {queryResult}
            </div>
          )}
        </MisakaCard>

        {/* Lore Log */}
        <MisakaCard padding="md" className="flex flex-col overflow-hidden">
          <div className="flex items-center gap-2 mb-4">
            <MisakaKanjiBlock char="録" size="sm" />
            <span className="font-kanji font-bold text-sm text-[var(--text-on-white)]">网络日志</span>
          </div>
          <div className="flex flex-col gap-2 overflow-y-auto" style={{ maxHeight: 200 }}>
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

// ── Page ──────────────────────────────────────────────────────────
export default function ACGN() {
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      {/* Hero */}
      <section
        className="relative grid overflow-hidden"
        style={{ gridTemplateColumns: '44% 1fr', minHeight: 'min(80vh, 680px)', paddingTop: 64 }}
      >
        <div className="relative flex items-end justify-center">
          <img
            src={HERO_CHARACTER}
            alt="御坂美琴"
            className="animate-float select-none pointer-events-none"
            style={{ maxHeight: 'calc(min(80vh, 680px) - 64px)', width: '100%', objectFit: 'contain', objectPosition: 'bottom center' }}
            draggable={false}
          />
        </div>
        <div className="flex flex-col justify-center pr-12 pl-8 gap-6" style={{ paddingBottom: '3rem', paddingTop: '2rem' }}>
          <img
            src={HERO_TITLE}
            alt="とある科学 御坂网络"
            className="select-none pointer-events-none"
            style={{ width: 'clamp(240px, 28vw, 400px)', filter: 'drop-shadow(0 6px 16px rgba(0,0,0,0.18))' }}
            draggable={false}
          />
          <p className="font-jp text-lg text-[var(--text-on-blue)] leading-loose">
            连接全部御坂妹妹的脑量子波共享网络<br />
            <span className="text-sm text-[var(--text-on-blue-2)]">全ての御坂妹妹を繋ぐ脳量子波ネットワーク</span>
          </p>
          <div className="flex gap-3">
            <MisakaButton variant="pill" size="sm" onClick={() => document.getElementById('about')?.scrollIntoView({ behavior: 'smooth' })}>
              了解更多
            </MisakaButton>
          </div>
        </div>
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ left: '44%', backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.06) 1px, transparent 1px)', backgroundSize: '24px 24px' }}
        />
      </section>

      {/* About */}
      <section id="about" className="px-8 py-14">
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

      {/* Footer */}
      <footer
        id="credits"
        className="px-8 py-14 text-center"
        style={{ background: 'var(--bg-deep)' }}
      >
        <MisakaKanjiBlock char="敬" size="xl" className="mx-auto mb-6" />
        <div className="font-jp text-sm text-[var(--text-on-blue-2)] leading-loose space-y-2">
          <p className="text-white text-base font-kanji font-semibold">御坂网络 / MISAKA NETWORK · 粉丝作品</p>
          <p className="font-jp">みさかネットワーク · ファン制作</p>
          <p className="mt-4">
            本作品致敬 <strong className="text-white">镰池和马</strong>、<strong className="text-white">冬川基</strong> 的原作<br />
            《某科学的超电磁炮》A Certain Scientific Railgun<br />
            <span className="font-jp">とある科学の超電磁砲</span>
          </p>
          <p className="mt-4 text-xs">
            · 非商业用途 Non-Commercial　· 不存储用户文件 No File Storage<br />
            · 所有版权归原作者所有 All Rights Reserved to Original Creators
          </p>
        </div>
        <div className="flex justify-center gap-4 mt-8">
          {['GitHub', '反馈', '服务条款', '隐私政策'].map(label => (
            <button key={label} className="nav-pill text-xs py-1.5 px-4">{label}</button>
          ))}
        </div>
      </footer>
    </div>
  )
}
