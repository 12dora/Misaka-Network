import { useAuthStore } from '@/store/auth'
import LoginCard from '@/components/features/LoginCard'
import StatsDashboard from '@/components/features/StatsDashboard'
import ActivityStream from '@/components/features/ActivityStream'
import QuickJoin from '@/components/features/QuickJoin'

const HERO_CHARACTER = '/assets/misaka.webp'
const HERO_TITLE     = '/assets/misaka-title.webp'

export default function Home() {
  const isConnected = useAuthStore(s => s.isConnected)

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-primary)' }}>

      {/* ── Mobile Hero ─────────────────────────────────────────────── */}
      <section className="md:hidden flex flex-col pt-16" style={{ minHeight: 'calc(100svh - 64px)' }}>
        {/* Character: upper portion of screen */}
        <div className="relative w-full flex-shrink-0 overflow-visible" style={{ height: '42vw', maxHeight: 240 }}>
          <img
            src={HERO_CHARACTER}
            alt="御坂美琴"
            className="animate-float select-none pointer-events-none"
            style={{
              position: 'absolute',
              bottom: 0,
              left: '50%',
              transform: 'translateX(-50%)',
              height: '220%',
              objectFit: 'contain',
              objectPosition: 'bottom center',
              zIndex: 0,
            }}
            draggable={false}
          />
          {/* fade to bg at top */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background: 'linear-gradient(to bottom, var(--bg-primary) 0%, transparent 35%)',
              zIndex: 1,
            }}
          />
        </div>

        {/* Content below character */}
        <div className="relative z-10 flex flex-col items-center px-5 pt-4 pb-10 gap-6 flex-1">
          <img
            src={HERO_TITLE}
            alt="とある科学 御坂网络"
            className="select-none pointer-events-none"
            style={{
              width: 'min(260px, 72vw)',
              height: 'auto',
              filter: 'drop-shadow(0 4px 12px rgba(0,0,0,0.22))',
            }}
            draggable={false}
          />
          <div className="w-full max-w-[420px]">
            <LoginCard />
          </div>
        </div>
      </section>

      {/* ── Desktop Hero (44 / 56 split) ─────────────────────────── */}
      <section
        className="relative hidden md:grid overflow-hidden"
        style={{
          gridTemplateColumns: '44% 1fr',
          minHeight: 'min(100vh, 820px)',
          paddingTop: 64,
        }}
      >
        {/* Left: Character illustration */}
        <div className="relative flex items-end justify-center">
          <img
            src={HERO_CHARACTER}
            alt="御坂美琴"
            className="animate-float select-none pointer-events-none"
            style={{
              maxHeight: 'calc(min(100vh, 820px) - 64px)',
              width: '100%',
              objectFit: 'contain',
              objectPosition: 'bottom center',
            }}
            draggable={false}
          />
        </div>

        {/* Right: Title + LoginCard */}
        <div
          className="flex flex-col justify-center pr-12 pl-8 gap-10 relative z-10"
          style={{ paddingTop: '2rem', paddingBottom: '3rem' }}
        >
          <div>
            <img
              src={HERO_TITLE}
              alt="とある科学 御坂网络"
              className="select-none pointer-events-none"
              style={{
                width: 'clamp(280px, 32vw, 460px)',
                height: 'auto',
                filter: 'drop-shadow(0 6px 16px rgba(0,0,0,0.18))',
              }}
              draggable={false}
            />
          </div>
          <LoginCard />
        </div>

        {/* Dot grid on right half */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            left: '44%',
            backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.06) 1px, transparent 1px)',
            backgroundSize: '24px 24px',
          }}
        />
      </section>

      {/* ── Stats ───────────────────────────────────────────────────── */}
      <StatsDashboard />

      {/* ── Activity Stream ─────────────────────────────────────────── */}
      <ActivityStream />

      {/* ── Quick Join ──────────────────────────────────────────────── */}
      {!isConnected && <QuickJoin />}

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <footer
        className="px-6 py-10 text-center"
        style={{ background: 'var(--bg-deep)' }}
      >
        <p className="font-jp text-sm text-[var(--text-on-blue-2)] leading-loose">
          御坂网络 / MISAKA NETWORK · 粉丝作品<br />
          致敬 镰池和马、冬川基 的原作《某科学的超电磁炮》<br />
          <span className="text-xs">非商业 · 不存储用户文件 · 所有版权归原作者</span>
        </p>
      </footer>
    </div>
  )
}
