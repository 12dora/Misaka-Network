import { useState, useEffect, useId, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'
import MisakaButton from '@/components/ui/MisakaButton'
import MisakaDialog from '@/components/ui/MisakaDialog'
import MisakaSwitch from '@/components/ui/MisakaSwitch'
import {
  loadTurnSettings, saveTurnSettings, testTurnServerDetailed,
  fetchTurnStatus, getAutoTurnState, refreshAutoTurn,
  isValidTurnUrl, type TurnServer, type TurnSettings, type TurnTestResult,
} from '@/lib/turn'
import { detectNatType, type NatDetectionResult } from '@/lib/nat'
import { isSoundEnabled, setSoundEnabled, subscribeSoundPreference, playSound } from '@/lib/sound'
import { ensureNotificationPermission } from '@/lib/notify'
import { useModalExit } from '@/hooks/useModalExit'

// A11Y-002: `color` here is the FILL used for the badge background (white
// text on top), `textColor` is the AA-verified foreground for the same
// state when it is rendered as small text on a light surface.
const NAT_TYPE_LABEL: Record<NatDetectionResult['type'], { label: string; color: string; textColor: string }> = {
  open:       { label: '开放（无 NAT）',     color: 'var(--state-success)', textColor: 'var(--state-success-on-light)' },
  cone:       { label: '锥型 NAT（可直连）', color: 'var(--state-success)', textColor: 'var(--state-success-on-light)' },
  // P1-3 (other agent): IPv6-only networks deserve their own label so the
  // user understands the connection mode rather than being told their NAT
  // is generic-cone.
  'cone-v6':  { label: '锥型 NAT（IPv6）',   color: 'var(--state-success)', textColor: 'var(--state-success-on-light)' },
  symmetric:  { label: '对称 NAT（需 TURN）',color: 'var(--state-warn)',    textColor: 'var(--state-warn-on-light)' },
  blocked:    { label: 'UDP 受限',          color: 'var(--state-warn)',    textColor: 'var(--state-warn-on-light)' },
  unknown:    { label: '未知',              color: 'var(--text-muted)',    textColor: 'var(--text-muted-on-light)' },
}

interface Props {
  onClose: () => void
}

type SettingsTab = 'turn' | 'sound' | 'about'

interface TurnStatusView {
  enabled: boolean
  configured: boolean
  available: boolean
  reason?: string
  credentialTtlSec: number
}

// BUG-026: every diagnostic now has an explicit lifecycle instead of a
// boolean that could be left stuck at `true` when the underlying promise
// rejected.
type ProbeState = 'idle' | 'running' | 'done' | 'error'

export default function SettingsModal({ onClose }: Props) {
  const [tab, setTab] = useState<SettingsTab>('turn')
  const [turnSettings, setTurnSettings] = useState<TurnSettings>(loadTurnSettings)
  const [editingServer, setEditingServer] = useState<TurnServer | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, TurnTestResult>>({})
  const [soundOn, setSoundOn] = useState(isSoundEnabled)
  const [natResult, setNatResult] = useState<NatDetectionResult | null>(null)
  const [natState, setNatState] = useState<ProbeState>('idle')
  const [natError, setNatError] = useState<string | null>(null)
  const [turnStatus, setTurnStatus] = useState<TurnStatusView | null>(null)
  const [turnStatusState, setTurnStatusState] = useState<ProbeState>('idle')
  const [turnStatusRetry, setTurnStatusRetry] = useState(0)
  const [autoTurnActive, setAutoTurnActive] = useState(getAutoTurnState())
  const [issuing, setIssuing] = useState(false)
  const [issueError, setIssueError] = useState<string | null>(null)
  const navigate = useNavigate()
  const modal = useModalExit(onClose)

  const fieldId = useId()
  const urlId = `turn-url-${fieldId}`
  const userId = `turn-user-${fieldId}`
  const passId = `turn-pass-${fieldId}`

  // Poll server TURN status while the TURN tab is open — cheap (no secrets),
  // gives the user live view of the kill switch + monthly burn.
  // Serial schedule (settle → wait 10s → next) so a hung network cannot
  // pile up ~60 overlapping requests. Each request has its own deadline
  // inside fetchTurnStatus; unmount aborts the in-flight one.
  useEffect(() => {
    if (tab !== 'turn') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const ac = new AbortController()
    const tick = async () => {
      setTurnStatusState(prev => (prev === 'idle' ? 'running' : prev))
      const s = await fetchTurnStatus(ac.signal)
      if (cancelled) return
      if (!s) {
        setTurnStatusState('error')
      } else {
        setTurnStatus({
          enabled: s.enabled, configured: s.configured,
          available: s.available, reason: s.reason,
          credentialTtlSec: s.credentialTtlSec,
        })
        setTurnStatusState('done')
        setAutoTurnActive(getAutoTurnState())
      }
      if (cancelled) return
      timer = setTimeout(() => { void tick() }, 10_000)
    }
    void tick()
    return () => {
      cancelled = true
      ac.abort()
      if (timer) clearTimeout(timer)
    }
  }, [tab, turnStatusRetry])

  async function handleDetectNat() {
    if (natState === 'running') return
    setNatState('running')
    setNatError(null)
    try {
      const result = await detectNatType()
      setNatResult(result)
      setNatState('done')
    } catch (err) {
      // BUG-026: detectNatType() builds an RTCPeerConnection and awaits an
      // offer. On a WebRTC-disabled browser it rejects, the old `finally`
      // cleared the spinner and nothing else happened — the button just
      // went back to "开始检测" with no result and no reason.
      console.warn('[settings] NAT detection failed', err)
      setNatState('error')
      setNatError('无法完成网络类型检测。请确认浏览器未屏蔽 WebRTC，然后重试。')
    }
  }

  // Form state
  const [form, setForm] = useState({
    url: '', username: '', credential: '',
  })

  // Persist only after a *real* value change relative to the loaded baseline.
  // A one-shot "first effect run" ref is NOT enough: React StrictMode re-runs
  // setup→cleanup→setup on the same instance, so the second setup would write
  // the default `enabled:false` and collapse unset → disabled.
  const turnSettingsBaseline = useRef<string | null>(null)
  useEffect(() => {
    const snap = JSON.stringify(turnSettings)
    if (turnSettingsBaseline.current === null) {
      turnSettingsBaseline.current = snap
      return
    }
    if (snap === turnSettingsBaseline.current) return
    turnSettingsBaseline.current = snap
    saveTurnSettings(turnSettings)
  }, [turnSettings])

  useEffect(() => subscribeSoundPreference(setSoundOn), [])

  // ── BUG-008 (UI half) ───────────────────────────────────────────────
  // The master switch must gate BOTH the manual server list and the
  // server-issued auto credentials, and "force relay" must be impossible to
  // leave armed when there is no TURN to relay through — that combination
  // guarantees every connection fails.
  const hasManualTurn = turnSettings.servers.some(s =>
    s.enabled
    && isValidTurnUrl(s.url)
    && s.username.trim().length > 0
    && s.credential.length > 0,
  )
  const turnAvailable = turnSettings.enabled && (hasManualTurn || autoTurnActive.active)

  useEffect(() => {
    if (!turnAvailable && turnSettings.forceRelay) {
      setTurnSettings(s => (s.forceRelay ? { ...s, forceRelay: false } : s))
    }
  }, [turnAvailable, turnSettings.forceRelay])

  const forceRelayHint = useMemo(() => {
    if (!turnSettings.enabled) return '需要先启用 TURN 中继'
    if (!turnAvailable) return '当前没有可用的中继服务器，开启后将无法建立连接'
    return '仅测试用：强制所有连接经过中继'
  }, [turnSettings.enabled, turnAvailable])

  function handleAdd() {
    if (!isValidTurnUrl(form.url)) return
    const server: TurnServer = {
      id: crypto.randomUUID(),
      url: form.url,
      username: form.username,
      credential: form.credential,
      enabled: true,
    }
    setTurnSettings(s => ({ ...s, servers: [...s.servers, server] }))
    setForm({ url: '', username: '', credential: '' })
  }

  function handleUpdate() {
    if (!editingServer || !isValidTurnUrl(form.url)) return
    setTurnSettings(s => ({
      ...s,
      servers: s.servers.map(srv =>
        srv.id === editingServer.id
          ? { ...srv, url: form.url, username: form.username, credential: form.credential }
          : srv,
      ),
    }))
    setEditingServer(null)
    setForm({ url: '', username: '', credential: '' })
  }

  function handleEdit(server: TurnServer) {
    setEditingServer(server)
    setForm({ url: server.url, username: server.username, credential: server.credential })
  }

  function handleDelete(id: string) {
    // If the user is mid-edit on this row, clear the editing state and reset
    // the form fields first — otherwise the edit form would silently target a
    // server that no longer exists and "保存" would no-op.
    if (editingServer?.id === id) {
      setEditingServer(null)
      setForm({ url: '', username: '', credential: '' })
    }
    setTurnSettings(s => ({ ...s, servers: s.servers.filter(srv => srv.id !== id) }))
    setTestResults(r => {
      const next = { ...r }
      delete next[id]
      return next
    })
  }

  function handleToggleServer(id: string) {
    setTurnSettings(s => ({
      ...s,
      servers: s.servers.map(srv =>
        srv.id === id ? { ...srv, enabled: !srv.enabled } : srv,
      ),
    }))
  }

  async function handleTest(server: TurnServer) {
    if (testingId) return
    setTestingId(server.id)
    try {
      // BUG-026: testTurnServerDetailed never rejects; the try/finally is
      // belt-and-braces so a future change can't strand the spinner again.
      const result = await testTurnServerDetailed(server)
      setTestResults(r => ({ ...r, [server.id]: result }))
      setTurnSettings(s => ({
        ...s,
        servers: s.servers.map(srv =>
          srv.id === server.id
            ? { ...srv, reachable: result.reachable, lastTested: Date.now() }
            : srv,
        ),
      }))
    } catch (err) {
      console.warn('[settings] TURN test threw', err)
      setTestResults(r => ({
        ...r,
        [server.id]: {
          reachable: false,
          code: 'SETUP_FAILED',
          message: '测试无法启动。请检查地址格式后重试。',
        },
      }))
    } finally {
      setTestingId(null)
    }
  }

  function handleSoundToggle(next: boolean) {
    setSoundEnabled(next)
    setSoundOn(next)
    if (next) playSound('scan')
  }

  return (
    <MisakaDialog
      title="设置"
      description="中继、音效与关于本应用的设置"
      onRequestClose={modal.requestClose}
      backdropClass={modal.backdropClass}
      panelClass={modal.panelClass}
      backdropStyle={{ background: 'rgba(14,42,107,0.55)', backdropFilter: 'blur(8px)' }}
      panelClassName="relative flex flex-col rounded-2xl"
      panelStyle={{
        background: 'var(--surface)',
        boxShadow: 'var(--shadow-float)',
        maxWidth: 480,
        width: '100%',
        maxHeight: '80vh',
      }}
      renderHeader={({ titleId, descriptionId }) => (
        <>
          {/* Header */}
          <div
            className="flex items-center justify-between px-6 py-4 border-b"
            style={{ borderColor: 'var(--border-card)' }}
          >
            <div className="flex items-center gap-2">
              <MisakaKanjiBlock char="設" size="sm" />
              <h2 id={titleId} className="font-kanji font-bold text-sm text-[var(--text-on-white)] m-0">设置</h2>
            </div>
            <button
              className="tap-target w-7 h-7 flex items-center justify-center rounded-full cursor-pointer hover:opacity-70 transition-opacity"
              style={{ border: 'none', background: 'var(--surface-tint)', color: 'var(--text-on-white)' }}
              onClick={modal.requestClose}
              aria-label="关闭设置"
            >
              ✕
            </button>
          </div>
          <p id={descriptionId} className="sr-only">中继、音效与关于本应用的设置</p>
        </>
      )}
    >
      {/* Tabs */}
      <div className="flex border-b" style={{ borderColor: 'var(--border-card)' }} role="tablist" aria-label="设置分类">
        {([
          { id: 'turn' as const, label: '中继' },
          { id: 'sound' as const, label: '音效' },
          { id: 'about' as const, label: '关于' },
        ]).map(t => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className="flex-1 py-2.5 text-center font-kanji text-xs cursor-pointer transition-colors"
            style={{
              border: 'none',
              background: 'transparent',
              color: tab === t.id ? 'var(--text-on-white)' : 'var(--text-muted-on-light)',
              borderBottom: tab === t.id ? '2px solid var(--bg-deep)' : '2px solid transparent',
              fontWeight: tab === t.id ? 700 : 400,
            }}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {/* ── TURN Settings ───────────────────────────────── */}
        {tab === 'turn' && (
          <div className="flex flex-col gap-4">
            {/* ── NAT type probe ──────────────────────────────── */}
            <div
              className="rounded-lg p-3 flex flex-col gap-2"
              style={{ background: 'var(--surface-tint)', border: '1px solid var(--border-card)' }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-kanji text-sm text-[var(--text-on-white)]">网络类型检测</span>
                <MisakaButton size="sm" onClick={handleDetectNat} disabled={natState === 'running'}>
                  {natState === 'running' ? '检测中…' : (natResult ? '重新检测' : '开始检测')}
                </MisakaButton>
              </div>
              {natState === 'error' && natError && (
                <p className="font-kanji text-[11px] leading-snug" style={{ color: 'var(--state-warn-on-light)' }} role="alert">
                  {natError}
                </p>
              )}
              {natResult && natState !== 'running' && (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span
                      className="inline-block px-2 py-0.5 rounded text-xs font-kanji text-white"
                      style={{ background: NAT_TYPE_LABEL[natResult.type].color }}
                    >
                      {NAT_TYPE_LABEL[natResult.type].label}
                    </span>
                    {natResult.publicEndpoints.length > 0 && (
                      <span className="font-mono text-[11px] text-[var(--text-muted-on-light)]">
                        {natResult.publicEndpoints.length} 个公网映射
                      </span>
                    )}
                  </div>
                  <p className="font-kanji text-[11px] text-[var(--text-on-white-2)] leading-snug">
                    {natResult.reason}
                    {(natResult.type === 'symmetric' || natResult.type === 'blocked') && (
                      <span className="block mt-1" style={{ color: 'var(--state-warn-on-light)' }}>
                        建议在下方启用 TURN 中继，否则与同类网络的对端可能无法直连。
                      </span>
                    )}
                  </p>
                </div>
              )}
            </div>

            {/* ── Auto TURN status (server-issued, read-only) ─── */}
            {turnStatusState === 'error' && !turnStatus && (
              <div
                className="rounded-lg p-3 flex flex-wrap items-center justify-between gap-2"
                style={{ background: 'var(--surface-tint)', border: '1px solid var(--border-card)' }}
                role="status"
              >
                <span className="font-kanji text-[11px]" style={{ color: 'var(--state-warn-on-light)' }}>
                  暂时无法获取中继服务状态
                </span>
                <MisakaButton
                  variant="pill"
                  size="sm"
                  className="text-[11px] py-1 px-2"
                  onClick={() => {
                    setTurnStatus(null)
                    setTurnStatusState('idle')
                    setTurnStatusRetry(value => value + 1)
                  }}
                >
                  重试
                </MisakaButton>
              </div>
            )}
            {turnStatus && (
              <div
                className="rounded-lg p-3 flex flex-col gap-2"
                style={{
                  background: 'var(--surface-tint)',
                  border: `1px solid ${turnStatus.available ? 'var(--border-card)' : 'var(--state-warn)'}`,
                }}
              >
                <div className="flex items-center justify-between">
                  <span className="font-kanji text-sm text-[var(--text-on-white)]">服务器自动下发</span>
                  <span
                    className="inline-block px-2 py-0.5 rounded text-[10px] font-kanji text-white"
                    style={{
                      background: !turnStatus.enabled ? 'var(--text-muted-on-light)'
                        : !turnStatus.configured ? 'var(--text-muted-on-light)'
                        : turnStatus.available && autoTurnActive.active ? 'var(--state-success-on-light)' : 'var(--state-warn-on-light)',
                    }}
                  >
                    {!turnStatus.enabled ? '已停用'
                      : !turnStatus.configured ? '未配置'
                      : !turnStatus.available ? '暂不可用'
                      : autoTurnActive.active ? '已下发' : '待下发'}
                  </span>
                </div>

                {autoTurnActive.active && autoTurnActive.expiresAt && (
                  <div className="flex items-center justify-between">
                    <span className="font-kanji text-[11px] text-[var(--text-on-white-2)]">凭证剩余</span>
                    <span className="font-mono text-[11px] text-[var(--text-on-white)]">
                      {Math.max(0, Math.floor((autoTurnActive.expiresAt - Date.now()) / 1000))}s
                      <span className="text-[var(--text-muted-on-light)]"> · TTL {turnStatus.credentialTtlSec}s</span>
                    </span>
                  </div>
                )}

                {turnStatus.configured && !turnStatus.available && (
                  <p className="font-kanji text-[10px] leading-snug" style={{ color: 'var(--state-warn-on-light)' }}>
                    中继服务暂时不可用。请稍后重试，或使用下方经过验证的手工服务器。
                  </p>
                )}

                {autoTurnActive.lastFailReason && !autoTurnActive.active && (
                  <p className="font-kanji text-[10px] leading-snug" style={{ color: 'var(--state-warn-on-light)' }}>
                    暂时无法获取中继凭证，可点击下方按钮重试。
                  </p>
                )}
              </div>
            )}

            <p className="font-kanji text-xs text-[var(--text-on-white-2)] leading-relaxed">
              服务器配置好中继服务后会自动下发短时效凭证；下方手工添加的 TURN 服务器在启用状态下生效。
              关闭「启用 TURN 中继」后，自动下发和手工服务器都不会用于连接。
            </p>

            {/* TURN issuance trigger — shown when pending; gated on master switch */}
            {turnStatus?.available && !autoTurnActive.active && (
              <div className="flex flex-col items-center gap-2">
                <MisakaButton
                  variant="primary"
                  size="sm"
                  disabled={issuing || !turnSettings.enabled}
                  onClick={async () => {
                    if (issuing || !turnSettings.enabled) return
                    setIssuing(true)
                    setIssueError(null)
                    try {
                      // force: user gesture may re-issue even after a prior fail
                      const servers = await refreshAutoTurn({ force: true })
                      setAutoTurnActive(getAutoTurnState())
                      if (servers.length === 0) {
                        setIssueError('暂时无法获取中继凭证。请检查网络后重试。')
                      }
                    } catch (err) {
                      // BUG-026: refreshAutoTurn is not supposed to reject,
                      // but a rejection here used to leave "下发中…" forever.
                      console.warn('[settings] TURN issuance failed', err)
                      setIssueError('暂时无法获取中继凭证。请检查网络后重试。')
                    } finally {
                      setIssuing(false)
                    }
                  }}
                >
                  {issuing ? '下发中…' : '下发中继凭证'}
                </MisakaButton>
                {issueError && (
                  <p className="font-kanji text-[11px]" style={{ color: 'var(--state-warn-on-light)' }} role="alert">
                    {issueError}
                  </p>
                )}
              </div>
            )}

            {/* Global toggle (A11Y-003: real switch semantics) */}
            <MisakaSwitch
              label="启用 TURN 中继"
              description="同时控制服务器自动下发和下方手工添加的服务器"
              checked={turnSettings.enabled}
              onChange={next => setTurnSettings(s => ({ ...s, enabled: next }))}
            />

            {/* Force relay toggle — BUG-008: unusable without an actual relay */}
            <MisakaSwitch
              label="强制使用 TURN（仅测试）"
              description={forceRelayHint}
              labelClassName="font-kanji text-xs text-[var(--text-on-white-2)]"
              checked={turnSettings.forceRelay}
              disabled={!turnAvailable}
              onColor="var(--state-warn)"
              onChange={next => setTurnSettings(s => ({ ...s, forceRelay: next }))}
            />

            {/* Server list */}
            {turnSettings.servers.map(s => {
              const result = testResults[s.id]
              return (
                <div
                  key={s.id}
                  className="rounded-xl p-3 flex flex-col gap-2"
                  style={{ background: 'var(--surface-tint)' }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs text-[var(--text-on-white)] truncate min-w-0">{s.url}</span>
                    <span className="font-mono text-[10px] shrink-0" style={{
                      color: s.reachable === true ? 'var(--state-success-on-light)'
                        : s.reachable === false ? 'var(--state-danger-on-light)'
                        : 'var(--text-muted-on-light)',
                    }}>
                      {testingId === s.id ? '测试中…'
                        : s.reachable === true ? '✓ 可达'
                        : s.reachable === false ? '✗ 不可达'
                        : '未测试'}
                    </span>
                  </div>
                  {/* BUG-026: a failed test now says what to do about it. */}
                  {result && !result.reachable && testingId !== s.id && (
                    <p className="font-kanji text-[10px] leading-snug" style={{ color: 'var(--state-warn-on-light)' }}>
                      {result.message}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-1.5">
                    <MisakaButton variant="pill" size="sm" className="text-[11px] py-1 px-2"
                      onClick={() => handleToggleServer(s.id)}>
                      {s.enabled ? '禁用' : '启用'}
                    </MisakaButton>
                    <MisakaButton variant="pill" size="sm" className="text-[11px] py-1 px-2"
                      onClick={() => handleTest(s)}
                      disabled={testingId === s.id}>
                      {testingId === s.id ? '测试中…' : '测试'}
                    </MisakaButton>
                    <MisakaButton variant="pill" size="sm" className="text-[11px] py-1 px-2"
                      onClick={() => handleEdit(s)}>
                      编辑
                    </MisakaButton>
                    <MisakaButton variant="pill" size="sm" className="text-[11px] py-1 px-2"
                      onClick={() => handleDelete(s.id)}>
                      <span style={{ color: 'var(--state-danger-on-light)' }}>删除</span>
                    </MisakaButton>
                  </div>
                </div>
              )
            })}

            {/* Add / Edit form — A11Y-004: real <label for> associations */}
            <div
              className="rounded-xl p-4 flex flex-col gap-3"
              style={{ background: 'var(--surface-tint)' }}
            >
              <div className="font-kanji text-xs font-semibold text-[var(--text-on-white)]">
                {editingServer ? '编辑 TURN 服务器' : '添加 TURN 服务器'}
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor={urlId} className="font-kanji text-[11px] text-[var(--text-on-white-2)]">
                  服务器地址
                </label>
                <input
                  id={urlId}
                  className="misaka-input text-xs"
                  placeholder="turn:example.com:3478?transport=udp"
                  value={form.url}
                  onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
                  aria-invalid={form.url.length > 0 && !isValidTurnUrl(form.url) ? true : undefined}
                />
                {form.url.length > 0 && !isValidTurnUrl(form.url) && (
                  <p className="font-kanji text-[10px]" style={{ color: 'var(--state-danger-on-light)' }} role="alert">
                    请输入以 turn: 或 turns: 开头的服务器地址
                  </p>
                )}
              </div>
              <div className="flex gap-2">
                <div className="flex flex-col gap-1 flex-1 min-w-0">
                  <label htmlFor={userId} className="font-kanji text-[11px] text-[var(--text-on-white-2)]">
                    用户名
                  </label>
                  <input
                    id={userId}
                    className="misaka-input text-xs"
                    autoComplete="off"
                    value={form.username}
                    onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                  />
                </div>
                <div className="flex flex-col gap-1 flex-1 min-w-0">
                  <label htmlFor={passId} className="font-kanji text-[11px] text-[var(--text-on-white-2)]">
                    密码
                  </label>
                  <input
                    id={passId}
                    className="misaka-input text-xs"
                    type="password"
                    autoComplete="off"
                    value={form.credential}
                    onChange={e => setForm(f => ({ ...f, credential: e.target.value }))}
                  />
                </div>
              </div>
              <div className="flex gap-2">
                {editingServer ? (
                  <>
                    <MisakaButton variant="primary" size="sm" onClick={handleUpdate} disabled={!isValidTurnUrl(form.url)}>保存</MisakaButton>
                    <MisakaButton variant="pill" size="sm"
                      onClick={() => { setEditingServer(null); setForm({ url: '', username: '', credential: '' }) }}>
                      取消
                    </MisakaButton>
                  </>
                ) : (
                  <MisakaButton variant="primary" size="sm" onClick={handleAdd} disabled={!isValidTurnUrl(form.url)}>
                    + 添加
                  </MisakaButton>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Sound ─────────────────────────────────────── */}
        {tab === 'sound' && (
          <div className="flex flex-col gap-4">
            <p className="font-kanji text-xs text-[var(--text-on-white-2)] leading-relaxed">
              扫码、传输完成、错误提示会播放短音效。设置只保存在本机。
            </p>
            <MisakaSwitch
              label="启用操作音效"
              checked={soundOn}
              onChange={handleSoundToggle}
            />
            <div className="grid grid-cols-3 gap-2">
              {([
                ['scan', '扫码'],
                ['complete', '完成'],
                ['error', '错误'],
              ] as const).map(([event, label]) => (
                <MisakaButton key={event} variant="pill" size="sm" onClick={() => playSound(event)}>
                  {label}
                </MisakaButton>
              ))}
            </div>
            <div className="pt-2 border-t" style={{ borderColor: 'var(--border-card)' }}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-kanji text-xs text-[var(--text-on-white-2)]">文件接收通知</span>
                <MisakaButton
                  variant="pill"
                  size="sm"
                  onClick={async () => {
                    const p = await ensureNotificationPermission()
                    if (p === 'granted') playSound('complete')
                  }}
                >
                  授权通知
                </MisakaButton>
              </div>
            </div>
          </div>
        )}

        {/* ── About / Legal ──────────────────────────────── */}
        {tab === 'about' && (
          <div className="flex flex-col gap-4">
            <div className="font-kanji text-xs text-[var(--text-on-white-2)] leading-relaxed">
              <p className="mb-2">© Master Huang · Misaka Network</p>
              <p className="mb-2">
                文件在浏览器之间端到端加密传输；直连失败时，流量可能经过服务器自动下发的
                Cloudflare TURN 或你配置的中继。信令会处理会话、IP 安全状态和聚合传输统计，
                部分安全/额度数据会跨重启保留。
              </p>
              <a
                href="https://github.com/12dora/Misaka-Network"
                target="_blank"
                rel="noreferrer"
                className="underline decoration-dotted"
              >
                GitHub
              </a>
            </div>
            <div className="flex flex-col gap-2">
              <MisakaButton variant="pill" size="sm" fullWidth
                onClick={() => { modal.requestClose(); window.setTimeout(() => navigate('/tos'), 180) }}>
                服务条款
              </MisakaButton>
              <MisakaButton variant="pill" size="sm" fullWidth
                onClick={() => { modal.requestClose(); window.setTimeout(() => navigate('/privacy'), 180) }}>
                隐私政策
              </MisakaButton>
            </div>
          </div>
        )}
      </div>
    </MisakaDialog>
  )
}
