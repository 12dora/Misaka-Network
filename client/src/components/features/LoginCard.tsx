import { useRef, useState, KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/store/auth'
import MisakaCard from '@/components/ui/MisakaCard'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'
import MisakaButton from '@/components/ui/MisakaButton'
import QRModal from '@/components/features/QRModal'
import ScanModal from '@/components/features/ScanModal'
import IpFullPrompt from '@/components/features/IpFullPrompt'
import { SPECIAL_NODE_HINTS } from '@/data/lore'
import {
  getPassChars as computePassChars,
  sanitisePastedPassCode,
  sanitiseDigit,
  applyDigit,
  applyBackspace,
} from '@/lib/passcode'

export default function LoginCard() {
  const navigate = useNavigate()
  const {
    identity, session, isConnected, isLoading, error, ipFullPrompt,
    setNodeId, setPassCode, regenerateNodeId, regeneratePassCode,
    connect, disconnect, releaseAllFromIp, dismissIpFullPrompt,
  } = useAuthStore()

  const passInputs = useRef<(HTMLInputElement | null)[]>([])
  const [showQR, setShowQR] = useState(false)
  const [showScan, setShowScan] = useState(false)
  const [releasing, setReleasing] = useState(false)
  // P1-8: track when the user types a node id outside the legal range so we
  // can surface an inline hint instead of silently no-op'ing setState.
  const [nodeIdError, setNodeIdError] = useState<string | null>(null)

  async function handleReleaseAndRetry(): Promise<number> {
    setReleasing(true)
    try {
      const released = await releaseAllFromIp()
      if (released > 0) await connect()
      if (useAuthStore.getState().isConnected) navigate('/network')
      return released
    } finally {
      setReleasing(false)
    }
  }

  function handleNodeIdChange(val: string) {
    if (val === '') {
      setNodeIdError(null)
      return
    }
    const n = parseInt(val, 10)
    if (isNaN(n)) {
      setNodeIdError('请输入有效的节点编号')
      return
    }
    if (n < 1 || n > 20001) {
      // P1-8: previously typing 20002 silently kept the old value with no
      // hint — users assumed the field accepted it. Clamp into range and
      // surface a non-blocking inline error so they understand the limit.
      const clamped = Math.min(20001, Math.max(1, n))
      setNodeId(clamped)
      setNodeIdError(`节点编号需在 1–20001 之间（已自动调整为 ${clamped}）`)
      return
    }
    setNodeIdError(null)
    setNodeId(n)
  }

  function getPassChars(): string[] {
    return computePassChars(identity.passCode)
  }

  function handlePassDigit(idx: number, val: string) {
    const digit = sanitiseDigit(val)
    if (!digit) return
    const result = applyDigit(identity.passCode, idx, digit)
    setPassCode(result.next)
    if (result.focusIdx !== idx) passInputs.current[result.focusIdx]?.focus()
  }

  function handlePassKey(idx: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace') {
      const result = applyBackspace(identity.passCode, idx)
      if (result.next !== identity.passCode) setPassCode(result.next)
      if (result.focusIdx !== idx) passInputs.current[result.focusIdx]?.focus()
      if (result.preventDefault) e.preventDefault()
    } else if (e.key === 'ArrowLeft' && idx > 0) {
      passInputs.current[idx - 1]?.focus()
    } else if (e.key === 'ArrowRight' && idx < 5) {
      passInputs.current[idx + 1]?.focus()
    }
  }

  function handlePassPaste(e: React.ClipboardEvent) {
    const text = sanitisePastedPassCode(e.clipboardData.getData('text'))
    if (text.length > 0) setPassCode(text)
  }

  // Whether passcode is complete (6 digits)
  const passComplete = /^\d{6}$/.test(identity.passCode)
  const specialHint = SPECIAL_NODE_HINTS[identity.nodeId]

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
      <MisakaCard padding="lg" className="w-full max-w-[420px] min-w-0 !p-5 xs:!p-6 sm:!p-8">
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
        <div className="font-kanji text-xs text-[var(--text-on-white-2)] mb-5">
          当前节点身份
        </div>
        {specialHint && (
          <div
            className="rounded-lg px-3 py-2 mb-5 font-kanji text-xs leading-relaxed"
            style={{ background: 'var(--surface-tint)', color: 'var(--text-on-white)' }}
          >
            <div className="font-semibold mb-0.5">{specialHint.title}</div>
            <div className="text-[var(--text-on-white-2)]">{specialHint.hint}</div>
          </div>
        )}

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
    <>
    {showScan && <ScanModal onClose={() => setShowScan(false)} />}
    {ipFullPrompt && (
      <IpFullPrompt
        busy={releasing}
        onConfirm={handleReleaseAndRetry}
        onCancel={dismissIpFullPrompt}
      />
    )}
    <MisakaCard
      padding="lg"
      className="w-full max-w-[420px] min-w-0 overflow-hidden !p-5 xs:!p-6 sm:!p-8"
      // P2-15: lets TopNav's "请先接入" nudge scroll this card into view
      // when the user clicks the disabled 网络 pill from any page.
      data-login-card
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        <MisakaKanjiBlock char="同" size="md" />
        <span className="font-kanji font-bold text-xl text-[var(--text-on-white)]">
          接入御坂网络
        </span>
      </div>
      <p className="font-kanji text-xs text-[var(--text-on-white-2)] mb-6">
        输入节点编号和通行码后即可接入
      </p>

      {/* Node ID */}
      <div className="mb-5">
        <label className="block text-xs font-kanji text-[var(--text-on-white-2)] mb-1.5">
          ◇ 节点编号
        </label>
        <div className="grid items-center gap-1.5 xs:gap-2" style={{ gridTemplateColumns: 'auto minmax(0, 1fr) auto auto' }}>
          <span className="font-kanji text-xs xs:text-sm text-[var(--text-on-white-2)] shrink-0">御坂</span>
          <input
            type="number"
            min={1}
            max={20001}
            value={identity.nodeId}
            onChange={e => handleNodeIdChange(e.target.value)}
            // P2 (mobile): force at least 16px on phones so iOS Safari doesn't
            // zoom on focus. text-lg = 1.125rem = 18px, which is already ≥16px,
            // but the inline style is explicit so future class changes don't
            // silently re-trigger the zoom.
            className="misaka-focus-ring min-w-0 flex-1 px-3 py-2 rounded-lg border text-center font-mono font-bold text-base xs:text-lg text-[var(--text-on-white)] focus:outline-none transition-colors"
            style={{
              borderColor: 'var(--border-card)',
              background: 'var(--surface)',
              fontSize: '16px',
            }}
            onFocus={e => (e.target.style.borderColor = 'var(--bg-deep)')}
            onBlur={e => (e.target.style.borderColor = 'var(--border-card)')}
            aria-label="节点编号"
          />
          <span className="font-kanji text-xs xs:text-sm text-[var(--text-on-white-2)] shrink-0">号</span>
          <button
            onClick={() => { regenerateNodeId(); setNodeIdError(null) }}
            className="w-8 h-8 rounded-full flex items-center justify-center transition-transform hover:rotate-180 duration-300 cursor-pointer shrink-0"
            style={{ background: 'var(--surface-tint)', color: 'var(--bg-deep)', border: 'none' }}
            title="重新生成"
            aria-label="重新生成"
          >
            ↻
          </button>
        </div>
        {nodeIdError && (
          <p
            className="mt-1 text-[11px] font-kanji"
            style={{ color: 'var(--state-warn)' }}
            role="alert"
          >
            ⚠ {nodeIdError}
          </p>
        )}
      </div>

      {specialHint && (
        <div
          className="rounded-lg px-3 py-2 mb-5 font-kanji text-xs leading-relaxed"
          style={{ background: 'var(--surface-tint)', color: 'var(--text-on-white)' }}
        >
          <div className="font-semibold mb-0.5">{specialHint.title}</div>
          <div className="text-[var(--text-on-white-2)]">{specialHint.hint}</div>
        </div>
      )}

      {/* Pass Code */}
      <fieldset className="mb-6" style={{ border: 'none', padding: 0, margin: 0 }}>
        <legend className="block text-xs font-kanji text-[var(--text-on-white-2)] mb-1.5" style={{ padding: 0 }}>
          ◇ 通行码
        </legend>
        {/* P1-14: screen-reader-only descriptor so the six digit cells read
            as a coherent group instead of six anonymous inputs. */}
        <span className="sr-only">通行码，6 位数字</span>
        <div className="grid items-center gap-1.5" style={{ gridTemplateColumns: 'repeat(6, minmax(0, 1fr)) auto' }}>
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
              // P0-3: `misaka-focus-ring` re-establishes a visible focus
              // outline. Tailwind's `focus:outline-none` is kept so the
              // platform default doesn't clash with the kanji-style ring.
              className="misaka-focus-ring w-full min-w-0 h-11 xs:h-12 text-center font-mono font-bold text-lg rounded-lg border focus:outline-none transition-colors"
              style={{
                borderColor: 'var(--border-card)',
                background: 'var(--surface)',
                color: 'var(--text-on-white)',
                fontSize: '16px',
              }}
              aria-label={`通行码第 ${i + 1} 位`}
            />
          ))}
          <button
            onClick={regeneratePassCode}
            className="w-8 h-8 rounded-full flex items-center justify-center hover:rotate-180 duration-300 transition-transform cursor-pointer ml-1 shrink-0"
            style={{ background: 'var(--surface-tint)', color: 'var(--bg-deep)', border: 'none' }}
            title="重新生成"
            type="button"
            aria-label="重新生成通行码"
          >
            ↻
          </button>
        </div>
      </fieldset>

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
        {isLoading ? '正在接入...' : '接入网络'}
      </MisakaButton>

      <div
        className="mt-3 rounded-xl p-3"
        style={{ background: 'var(--surface-tint)', border: '1px solid var(--border-card)' }}
      >
        <button
          type="button"
          onClick={() => setShowScan(true)}
          className="w-full flex items-center gap-3 text-left cursor-pointer"
          style={{ border: 'none', background: 'transparent', color: 'var(--text-on-white)' }}
        >
          <span
            className="grid place-items-center w-10 h-10 rounded-lg shrink-0 font-kanji font-bold"
            style={{
              background: 'linear-gradient(145deg, var(--bg-deep), var(--bg-soft))',
              color: '#fff',
              boxShadow: '0 8px 18px -10px rgba(14,42,107,0.55)',
            }}
          >
            読
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-kanji text-sm font-semibold">QR 接入</span>
            <span className="block font-kanji text-[11px] text-[var(--text-on-white-2)] leading-relaxed">
              扫描或粘贴对方节点链接，自动填入身份并接入
            </span>
          </span>
          <span className="font-mono text-[var(--accent-cyan)]">→</span>
        </button>
      </div>

      <p className="text-[10px] text-[var(--text-on-white-2)] text-center mt-3 font-kanji">
        ⓘ 30 分钟无活动会话自动释放
      </p>
    </MisakaCard>
    </>
  )
}
