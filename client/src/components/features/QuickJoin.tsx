import { useState, useLayoutEffect, useRef, KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import MisakaCard from '@/components/ui/MisakaCard'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'
import MisakaButton from '@/components/ui/MisakaButton'
import { useAuthStore } from '@/store/auth'

// ── Inline SVG icons ────────────────────────────────────────────────
function ScanIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" fill="none" className="mb-3 mx-auto">
      <rect x="4" y="4" width="12" height="12" rx="2" stroke="var(--bg-deep)" strokeWidth="2.5" />
      <rect x="24" y="4" width="12" height="12" rx="2" stroke="var(--bg-deep)" strokeWidth="2.5" />
      <rect x="4" y="24" width="12" height="12" rx="2" stroke="var(--bg-deep)" strokeWidth="2.5" />
      <rect x="24" y="24" width="12" height="12" rx="2" stroke="var(--bg-deep)" strokeWidth="2.5" />
      <line x1="20" y1="12" x2="20" y2="28" stroke="var(--accent-cyan)" strokeWidth="2" />
    </svg>
  )
}

function PasscodeIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" fill="none" className="mb-3 mx-auto">
      <rect x="7" y="17" width="26" height="20" rx="3" stroke="var(--bg-deep)" strokeWidth="2.5" />
      <path d="M14 17V11a6 6 0 0 1 12 0v6" stroke="var(--bg-deep)" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="20" cy="27" r="3" fill="var(--accent-cyan)" />
      <line x1="20" y1="29" x2="20" y2="33" stroke="var(--accent-cyan)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function LoreIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" fill="none" className="mb-3 mx-auto">
      <path d="M8 8h16l8 8v16a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V12a4 4 0 0 1 4-4z" stroke="var(--bg-deep)" strokeWidth="2.5" />
      <line x1="12" y1="18" x2="28" y2="18" stroke="var(--bg-deep)" strokeWidth="2" strokeLinecap="round" />
      <line x1="12" y1="23" x2="22" y2="23" stroke="var(--bg-deep)" strokeWidth="2" strokeLinecap="round" />
      <line x1="12" y1="28" x2="25" y2="28" stroke="var(--text-on-white-2)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

// ── Passcode Card (expandable) ──────────────────────────────────────
function PasscodeCard({ visible, animated, idx }: { visible: boolean; animated: boolean; idx: number }) {
  const [expanded, setExpanded] = useState(false)
  const [passCode, setPassCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const auth = useAuthStore()
  const navigate = useNavigate()

  function getPassChars(): string[] {
    const chars: string[] = []
    for (let i = 0; i < 6; i++) chars.push(passCode[i] ?? '')
    return chars
  }

  const inputsRef = useRef<(HTMLInputElement | null)[]>([])

  function handleDigit(idx: number, val: string) {
    const digit = val.replace(/\D/g, '').slice(-1)
    if (!digit) return
    const chars = getPassChars()
    chars[idx] = digit
    setPassCode(chars.join(''))
    inputsRef.current[idx + 1]?.focus()
  }

  function handleKey(idx: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace') {
      const chars = getPassChars()
      if (chars[idx]) {
        chars[idx] = ''
        setPassCode(chars.join(''))
      } else if (idx > 0) {
        chars[idx - 1] = ''
        setPassCode(chars.join(''))
        inputsRef.current[idx - 1]?.focus()
      }
      e.preventDefault()
    } else if (e.key === 'ArrowLeft' && idx > 0) {
      inputsRef.current[idx - 1]?.focus()
    } else if (e.key === 'ArrowRight' && idx < 5) {
      inputsRef.current[idx + 1]?.focus()
    }
  }

  function handlePaste(e: React.ClipboardEvent) {
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
    if (text.length > 0) setPassCode(text.padEnd(6, ''))
  }

  const passComplete = /^\d{6}$/.test(passCode)

  async function handleConnect() {
    setError(null)
    setLoading(true)
    auth.setPassCode(passCode)
    await auth.connect()
    setLoading(false)
    if (useAuthStore.getState().isConnected) {
      navigate('/network')
    } else {
      setError(useAuthStore.getState().error ?? '连接失败')
    }
  }

  if (!expanded) {
    return (
      <MisakaCard
        padding="md"
        className="flex flex-col items-center text-center hover:-translate-y-1 hover:shadow-float transition-all duration-200"
        style={{
          opacity: !visible ? 0 : animated ? 0 : undefined,
          animation: animated ? `card-in 0.45s ease ${idx * 0.1}s forwards` : 'none',
        }}
      >
        <PasscodeIcon />
        <div className="flex items-center gap-1.5 mb-1">
          <MisakaKanjiBlock char="入" size="sm" />
          <span className="font-kanji font-bold text-base text-[var(--text-on-white)]">输入通行码</span>
        </div>
        <p className="font-jp text-xs text-[var(--text-on-white-2)] mb-2">パスコード入力</p>
        <p className="font-kanji text-xs text-[var(--text-on-white-2)] mb-4 leading-relaxed">手动输入通行码建立连接</p>
        <MisakaButton
          variant="primary"
          size="sm"
          fullWidth
          onClick={() => setExpanded(true)}
        >
          打开输入
        </MisakaButton>
      </MisakaCard>
    )
  }

  return (
    <MisakaCard
      padding="md"
      className="flex flex-col items-center text-center"
      style={{
        opacity: !visible ? 0 : animated ? 0 : undefined,
        animation: animated ? `card-in 0.45s ease ${idx * 0.1}s forwards` : 'none',
      }}
    >
      <PasscodeIcon />
      <span className="font-kanji font-bold text-base text-[var(--text-on-white)] mb-3">输入通行码</span>

      {/* Passcode digit inputs */}
      <div className="flex items-center gap-1.5 mb-4">
        {getPassChars().map((digit, i) => (
          <input
            key={i}
            ref={el => { inputsRef.current[i] = el }}
            type="text"
            inputMode="numeric"
            maxLength={1}
            value={digit}
            placeholder="●"
            onChange={e => handleDigit(i, e.target.value)}
            onKeyDown={e => handleKey(i, e)}
            onPaste={handlePaste}
            autoFocus={i === 0}
            className="w-10 h-12 text-center font-mono font-bold text-lg rounded-lg border focus:outline-none transition-colors"
            style={{
              borderColor: 'var(--border-card)',
              background: 'var(--surface)',
              color: 'var(--text-on-white)',
            }}
            onFocus={e => { e.target.style.borderColor = 'var(--bg-deep)'; e.target.select() }}
            onBlur={e => (e.target.style.borderColor = 'var(--border-card)')}
          />
        ))}
      </div>

      {error && (
        <p className="text-xs text-[var(--state-danger)] mb-3 font-kanji">{error}</p>
      )}

      <div className="flex gap-2 w-full">
        <MisakaButton
          variant="pill" size="sm" className="flex-1"
          onClick={() => { setExpanded(false); setError(null); setPassCode('') }}
        >
          返回
        </MisakaButton>
        <MisakaButton
          variant="primary" size="sm" className="flex-1"
          disabled={loading || !passComplete}
          onClick={handleConnect}
        >
          {loading ? '接入中...' : '连接'}
        </MisakaButton>
      </div>
    </MisakaCard>
  )
}

// ── Main QuickJoin Section ──────────────────────────────────────────
export default function QuickJoin() {
  const navigate = useNavigate()
  const [visible, setVisible] = useState(false)
  const [animated, setAnimated] = useState(false)
  const gridRef = useRef<HTMLDivElement>(null)

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

  return (
    <section className="px-5 md:px-8 py-14">
      <div className="section-header">
        <div className="title-row">
          <MisakaKanjiBlock char="入" size="lg" />
          <h2>快速接入</h2>
        </div>
        <p className="furigana">クイックアクセス</p>
        <div className="accent-line" />
      </div>

      <div ref={gridRef} className="grid grid-cols-1 md:grid-cols-3 gap-5 max-w-3xl">
        {/* Scan Card */}
        <MisakaCard
          padding="md"
          className="flex flex-col items-center text-center hover:-translate-y-1 hover:shadow-float transition-all duration-200"
          style={{
            opacity: !visible ? 0 : animated ? 0 : undefined,
            animation: animated ? 'card-in 0.45s ease 0s forwards' : 'none',
          }}
        >
          <ScanIcon />
          <div className="flex items-center gap-1.5 mb-1">
            <MisakaKanjiBlock char="読" size="sm" />
            <span className="font-kanji font-bold text-base text-[var(--text-on-white)]">扫码接入</span>
          </div>
          <p className="font-jp text-xs text-[var(--text-on-white-2)] mb-2">カメラから接続</p>
          <p className="font-kanji text-xs text-[var(--text-on-white-2)] mb-4 leading-relaxed">扫描对方节点的 QR 码快速接入</p>
          <MisakaButton variant="primary" size="sm" fullWidth>
            开始扫描
          </MisakaButton>
        </MisakaCard>

        {/* Passcode Card */}
        <PasscodeCard visible={visible} animated={animated} idx={1} />

        {/* Lore Card */}
        <MisakaCard
          padding="md"
          className="flex flex-col items-center text-center hover:-translate-y-1 hover:shadow-float transition-all duration-200"
          style={{
            opacity: !visible ? 0 : animated ? 0 : undefined,
            animation: animated ? 'card-in 0.45s ease 0.2s forwards' : 'none',
          }}
        >
          <LoreIcon />
          <div className="flex items-center gap-1.5 mb-1">
            <MisakaKanjiBlock char="識" size="sm" />
            <span className="font-kanji font-bold text-base text-[var(--text-on-white)]">了解御坂网络</span>
          </div>
          <p className="font-jp text-xs text-[var(--text-on-white-2)] mb-2">みさかについて</p>
          <p className="font-kanji text-xs text-[var(--text-on-white-2)] mb-4 leading-relaxed">世界观介绍、角色档案与彩蛋功能</p>
          <MisakaButton
            variant="primary"
            size="sm"
            fullWidth
            onClick={() => navigate('/acgn')}
          >
            前往 ACGN
          </MisakaButton>
        </MisakaCard>
      </div>
    </section>
  )
}
