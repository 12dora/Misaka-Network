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
      {/* ── FirstFold: Hero ────────────────────────────────────── */}
      <section
        className="relative grid overflow-hidden"
        style={{
          gridTemplateColumns: '44% 1fr',
          minHeight: 'min(100vh, 820px)',
          paddingTop: 64, // nav height
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

        {/* Right: Nav area + Title + LoginCard */}
        <div
          className="flex flex-col justify-center pr-12 pl-8 gap-10"
          style={{ paddingTop: '2rem', paddingBottom: '3rem' }}
        >
          {/* Title Lockup */}
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

          {/* Login Card */}
          <LoginCard />
        </div>

        {/* Subtle dot grid overlay on right side */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            left: '44%',
            backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.06) 1px, transparent 1px)',
            backgroundSize: '24px 24px',
          }}
        />
      </section>

      {/* ── Second Fold: Stats ──────────────────────────────────── */}
      <StatsDashboard />

      {/* ── Third Fold: Activity Stream ─────────────────────────── */}
      <ActivityStream />

      {/* ── Fourth Fold: QuickJoin (unauthenticated) ────────────── */}
      {!isConnected && <QuickJoin />}

      {/* ── Footer ─────────────────────────────────────────────── */}
      <footer
        className="px-8 py-10 text-center"
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
