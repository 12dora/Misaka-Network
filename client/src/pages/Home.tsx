import { useId, type CSSProperties } from 'react'
import LoginCard from '@/components/features/LoginCard'
import StatsDashboard from '@/components/features/StatsDashboard'
import ActivityStream from '@/components/features/ActivityStream'
import AppFooter from '@/components/ui/AppFooter'

const HERO_CHARACTER = import.meta.env.BASE_URL + 'assets/misaka.webp'
const HERO_TITLE     = import.meta.env.BASE_URL + 'assets/misaka-title.webp'

function HeroTitle({ width }: { width: CSSProperties['width'] }) {
  const outlineId = useId().replace(/:/g, '')

  return (
    <svg
      className="block select-none pointer-events-none"
      role="img"
      aria-label="とある科学 御坂网络"
      viewBox="-40 -40 1616 1104"
      style={{
        width,
        height: 'auto',
        overflow: 'visible',
      }}
    >
      <defs>
        <filter
          id={outlineId}
          x="-80"
          y="-80"
          width="1696"
          height="1184"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feMorphology in="SourceAlpha" operator="dilate" radius="12" result="expanded" />
          <feFlood floodColor="#fff" result="white" />
          <feComposite in="white" in2="expanded" operator="in" result="outline" />
          <feMerge>
            <feMergeNode in="outline" />
          </feMerge>
        </filter>
      </defs>
      <image
        href={HERO_TITLE}
        x="0"
        y="0"
        width="1536"
        height="1024"
        preserveAspectRatio="xMidYMid meet"
        filter={`url(#${outlineId})`}
      />
      <image
        href={HERO_TITLE}
        x="0"
        y="0"
        width="1536"
        height="1024"
        preserveAspectRatio="xMidYMid meet"
      />
    </svg>
  )
}

export default function Home() {
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-primary)' }}>

      {/* ── Mobile Hero ─────────────────────────────────────────────── */}
      <section className="md:hidden relative overflow-hidden pt-16">
        <div
          className="absolute inset-0 pointer-events-none dot-grid"
          style={{
            opacity: 0.5,
            maskImage: 'linear-gradient(to bottom, #000 0%, transparent 72%)',
            WebkitMaskImage: 'linear-gradient(to bottom, #000 0%, transparent 72%)',
          }}
        />

        {/* Character stage */}
        <div
          className="relative w-full overflow-hidden"
          style={{
            height: 'clamp(310px, 50svh, 430px)',
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

        {/* Content below character */}
        <div className="relative z-10 flex flex-col items-center -mt-8 pb-10 gap-5">
          <HeroTitle width="min(230px, 62vw)" />
          <div className="w-[calc(100%_-_2rem)] max-w-[420px]">
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
            loading="eager"
            fetchPriority="high"
            decoding="async"
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
            <HeroTitle width="clamp(280px, 32vw, 460px)" />
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

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <AppFooter />
    </div>
  )
}
