import { useRef, useState, KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/store/auth'
import MisakaCard from '@/components/ui/MisakaCard'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'
import MisakaButton from '@/components/ui/MisakaButton'
import QRModal from '@/components/features/QRModal'

export default function LoginCard() {
  const navigate = useNavigate()
  const {
    identity, session, isConnected, isLoading, error,
    setNodeId, setPassCode, regenerateNodeId, regeneratePassCode,
    connect, disconnect,
  } = useAuthStore()

  const passInputs = useRef<(HTMLInputElement | null)[]>([])
  const [showQR, setShowQR] = useState(false)

  function handleNodeIdChange(val: string) {
    const n = parseInt(val, 10)
    if (!isNaN(n) && n >= 1 && n <= 20001) setNodeId(n)
  }

  // Pad passcode to 6 chars with empty strings for display
  function getPassChars(): string[] {
    const chars: string[] = []
    for (let i = 0; i < 6; i++) {
      chars.push(identity.passCode[i] ?? '')
    }
    return chars
  }

  function handlePassDigit(idx: number, val: string) {
    const digit = val.replace(/\D/g, '').slice(-1)
    if (!digit) return
    const chars = getPassChars()
    chars[idx] = digit
    setPassCode(chars.join(''))
    passInputs.current[idx + 1]?.focus()
  }

  function handlePassKey(idx: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace') {
      const chars = getPassChars()
      if (chars[idx]) {
        // Clear current digit and stay
        chars[idx] = ''
        setPassCode(chars.join(''))
      } else if (idx > 0) {
        // Already empty — move to previous and clear it
        chars[idx - 1] = ''
        setPassCode(chars.join(''))
        passInputs.current[idx - 1]?.focus()
      }
      e.preventDefault()
    } else if (e.key === 'ArrowLeft' && idx > 0) {
      passInputs.current[idx - 1]?.focus()
    } else if (e.key === 'ArrowRight' && idx < 5) {
      passInputs.current[idx + 1]?.focus()
    }
  }

  function handlePassPaste(e: React.ClipboardEvent) {
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
    if (text.length > 0) {
      setPassCode(text.padEnd(6, ''))
    }
  }

  // Whether passcode is complete (6 digits)
  const passComplete = /^\d{6}$/.test(identity.passCode)

  async function handleConnect() {
    await connect()
    if (useAuthStore.getState().isConnected) {
      navigate('/network')
    }
  }

  if (isConnected && session) {
    return (
      <>
      {showQR && (
        <QRModal
          nodeId={identity.nodeId}
          passCode={identity.passCode}
          onClose={() => setShowQR(false)}
        />
      )}
      <MisakaCard padding="lg" className="w-full max-w-[420px]">
        <div className="flex items-center gap-2 mb-1">
          <span
            className="pulse-dot inline-block w-2.5 h-2.5 rounded-full"
            style={{ background: 'var(--state-success)' }}
          />
          <span className="font-kanji text-sm font-semibold text-[var(--text-on-white-2)]">✓ 已接入</span>
        </div>
        <div className="font-kanji font-bold text-2xl text-[var(--text-on-white)] mb-0.5">
          御坂 {identity.nodeId} 号
        </div>
        <div className="font-jp text-xs text-[var(--text-on-white-2)] mb-5">
          みさか {identity.nodeId} ごう
        </div>

        <div className="flex items-center gap-2 mb-6 text-sm text-[var(--text-on-white-2)] font-kanji">
          通行码：
          <span className="font-mono tracking-widest text-[var(--text-on-white)]">
            {identity.passCode}
          </span>
        </div>

        <div className="flex flex-col gap-2">
          <MisakaButton
            variant="primary"
            fullWidth
            onClick={() => navigate('/network')}
          >
            📡 进入网络
          </MisakaButton>
          <div className="flex gap-2">
            <MisakaButton variant="pill" size="sm" className="flex-1" onClick={() => setShowQR(true)}>
              🔲 显示 QR
            </MisakaButton>
            <MisakaButton
              variant="pill"
              size="sm"
              className="flex-1"
              onClick={disconnect}
            >
              ⏏ 断开
            </MisakaButton>
          </div>
        </div>
      </MisakaCard>
      </>
    )
  }

  return (
    <MisakaCard padding="lg" className="w-full max-w-[420px]">
      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        <MisakaKanjiBlock char="同" size="md" />
        <span className="font-kanji font-bold text-xl text-[var(--text-on-white)]">
          接入御坂网络
        </span>
      </div>
      <p className="font-jp text-xs text-[var(--text-on-white-2)] mb-6">
        みさかネットワークへ
      </p>

      {/* Node ID */}
      <div className="mb-5">
        <label className="block text-xs font-kanji text-[var(--text-on-white-2)] mb-1.5">
          ◇ 节点编号
        </label>
        <div className="flex items-center gap-2">
          <span className="font-kanji text-sm text-[var(--text-on-white-2)]">御坂</span>
          <input
            type="number"
            min={1}
            max={20001}
            value={identity.nodeId}
            onChange={e => handleNodeIdChange(e.target.value)}
            className="flex-1 px-3 py-2 rounded-lg border text-center font-mono font-bold text-lg text-[var(--text-on-white)] focus:outline-none transition-colors"
            style={{
              borderColor: 'var(--border-card)',
              background: 'var(--surface)',
            }}
            onFocus={e => (e.target.style.borderColor = 'var(--bg-deep)')}
            onBlur={e => (e.target.style.borderColor = 'var(--border-card)')}
          />
          <span className="font-kanji text-sm text-[var(--text-on-white-2)]">号</span>
          <button
            onClick={regenerateNodeId}
            className="w-8 h-8 rounded-full flex items-center justify-center transition-transform hover:rotate-180 duration-300 cursor-pointer"
            style={{ background: 'var(--surface-tint)', color: 'var(--bg-deep)', border: 'none' }}
            title="重新生成"
          >
            ↻
          </button>
        </div>
      </div>

      {/* Pass Code */}
      <div className="mb-6">
        <label className="block text-xs font-kanji text-[var(--text-on-white-2)] mb-1.5">
          ◇ 通行码
        </label>
        <div className="flex items-center gap-1.5">
          {getPassChars().map((digit, i) => (
            <input
              key={i}
              ref={el => { passInputs.current[i] = el }}
              type="text"
              inputMode="numeric"
              maxLength={1}
              value={digit}
              placeholder="●"
              onChange={e => handlePassDigit(i, e.target.value)}
              onKeyDown={e => handlePassKey(i, e)}
              onPaste={handlePassPaste}
              onFocus={e => {
                e.target.style.borderColor = 'var(--bg-deep)'
                e.target.select()
              }}
              onBlur={e => (e.target.style.borderColor = 'var(--border-card)')}
              className="w-10 h-12 text-center font-mono font-bold text-lg rounded-lg border focus:outline-none transition-colors"
              style={{
                borderColor: 'var(--border-card)',
                background: 'var(--surface)',
                color: 'var(--text-on-white)',
              }}
            />
          ))}
          <button
            onClick={regeneratePassCode}
            className="w-8 h-8 rounded-full flex items-center justify-center hover:rotate-180 duration-300 transition-transform cursor-pointer ml-1"
            style={{ background: 'var(--surface-tint)', color: 'var(--bg-deep)', border: 'none' }}
            title="重新生成"
          >
            ↻
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <p className="text-xs text-[var(--state-danger)] mb-4 font-kanji">
          ⚠ {error}
        </p>
      )}

      {/* Connect Button */}
      <MisakaButton
        variant="primary"
        fullWidth
        onClick={handleConnect}
        disabled={isLoading || !passComplete}
      >
        {isLoading ? '正在接入...' : '接入网络 / CONNECT'}
      </MisakaButton>

      <p className="text-[10px] text-[var(--text-on-white-2)] text-center mt-3 font-kanji">
        ⓘ 30 分钟无活动会话自动释放
      </p>
    </MisakaCard>
  )
}
