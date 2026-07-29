import { useState, useEffect, useId, useMemo, useRef, useCallback, type KeyboardEvent } from 'react'
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
import { settings as copy } from '@/copy/zh-CN/settings'

// A11Y-002: `color` here is the FILL used for the badge background (white
// text on top), `textColor` is the AA-verified foreground for the same
// state when it is rendered as small text on a light surface.
const NAT_TYPE_LABEL: Record<NatDetectionResult['type'], { label: string; color: string; textColor: string }> = {
  open:       { label: copy.nat.open,       color: 'var(--state-success)', textColor: 'var(--state-success-on-light)' },
  cone:       { label: copy.nat.cone,       color: 'var(--state-success)', textColor: 'var(--state-success-on-light)' },
  'cone-v6':  { label: copy.nat['cone-v6'], color: 'var(--state-success)', textColor: 'var(--state-success-on-light)' },
  symmetric:  { label: copy.nat.symmetric,  color: 'var(--state-warn)',    textColor: 'var(--state-warn-on-light)' },
  blocked:    { label: copy.nat.blocked,    color: 'var(--state-warn)',    textColor: 'var(--state-warn-on-light)' },
  unknown:    { label: copy.nat.unknown,    color: 'var(--text-muted)',    textColor: 'var(--text-muted-on-light)' },
}

interface Props {
  onClose: () => void
}

type SettingsTab = 'turn' | 'sound' | 'about'

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'turn', label: copy.tabs.turn },
  { id: 'sound', label: copy.tabs.sound },
  { id: 'about', label: copy.tabs.about },
]

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
  const [advancedOpen, setAdvancedOpen] = useState(false)
  // 08 P1: pending delete confirmation — never persist until the user confirms.
  const [pendingDelete, setPendingDelete] = useState<TurnServer | null>(null)
  const keepDeleteRef = useRef<HTMLButtonElement>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const navigate = useNavigate()
  const modal = useModalExit(onClose)

  const fieldId = useId()
  const urlId = `turn-url-${fieldId}`
  const userId = `turn-user-${fieldId}`
  const passId = `turn-pass-${fieldId}`
  const tabPanelId = {
    turn: `settings-panel-turn-${fieldId}`,
    sound: `settings-panel-sound-${fieldId}`,
    about: `settings-panel-about-${fieldId}`,
  }
  const tabId = {
    turn: `settings-tab-turn-${fieldId}`,
    sound: `settings-tab-sound-${fieldId}`,
    about: `settings-tab-about-${fieldId}`,
  }

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
      setNatError(copy.natDetectFailed)
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
    if (!turnSettings.enabled) return copy.forceRelayNeedSwitch
    if (!turnAvailable) return copy.forceRelayNoServer
    return copy.forceRelayHint
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
    setAdvancedOpen(true)
  }

  /** Apply a confirmed delete. Persistence is driven by the turnSettings effect. */
  function commitDelete(id: string) {
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
    setPendingDelete(null)
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
          message: copy.testFailed,
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

  // 08 P2: roving tabindex + Arrow/Home/End for the settings tablist.
  const focusTab = useCallback((index: number) => {
    const next = TABS[index]
    if (!next) return
    setTab(next.id)
    tabRefs.current[index]?.focus()
  }, [])

  function onTabKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (index + 1) % TABS.length
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = (index - 1 + TABS.length) % TABS.length
        break
      case 'Home':
        nextIndex = 0
        break
      case 'End':
        nextIndex = TABS.length - 1
        break
      default:
        return
    }
    e.preventDefault()
    focusTab(nextIndex)
  }

  return (
    <>
    <MisakaDialog
      title={copy.title}
      description={copy.description}
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
              <h2 id={titleId} className="font-kanji font-bold text-sm text-[var(--text-on-white)] m-0">{copy.title}</h2>
            </div>
            <button
              className="tap-target w-7 h-7 flex items-center justify-center rounded-full cursor-pointer hover:opacity-70 transition-opacity"
              style={{ border: 'none', background: 'var(--surface-tint)', color: 'var(--text-on-white)' }}
              onClick={() => modal.requestClose()}
              aria-label={copy.closeAria}
            >
              ✕
            </button>
          </div>
          <p id={descriptionId} className="sr-only">{copy.description}</p>
        </>
      )}
    >
      {/* Tabs — roving tabindex, aria-controls ↔ tabpanel */}
      <div className="flex border-b" style={{ borderColor: 'var(--border-card)' }} role="tablist" aria-label="设置分类">
        {TABS.map((t, index) => (
          <button
            key={t.id}
            ref={el => { tabRefs.current[index] = el }}
            id={tabId[t.id]}
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={tabPanelId[t.id]}
            tabIndex={tab === t.id ? 0 : -1}
            className="flex-1 py-2.5 text-center font-kanji text-xs cursor-pointer transition-colors"
            style={{
              border: 'none',
              background: 'transparent',
              color: tab === t.id ? 'var(--text-on-white)' : 'var(--text-muted-on-light)',
              borderBottom: tab === t.id ? '2px solid var(--bg-deep)' : '2px solid transparent',
              fontWeight: tab === t.id ? 700 : 400,
            }}
            onClick={() => setTab(t.id)}
            onKeyDown={e => onTabKeyDown(e, index)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {/* ── Connection / TURN Settings ──────────────────── */}
        {tab === 'turn' && (
          <div
            className="flex flex-col gap-4"
            role="tabpanel"
            id={tabPanelId.turn}
            aria-labelledby={tabId.turn}
          >
            {/* ── NAT type probe ──────────────────────────────── */}
            <div
              className="rounded-lg p-3 flex flex-col gap-2"
              style={{ background: 'var(--surface-tint)', border: '1px solid var(--border-card)' }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-kanji text-sm text-[var(--text-on-white)]">{copy.networkType}</span>
                <MisakaButton size="sm" onClick={handleDetectNat} disabled={natState === 'running'}>
                  {natState === 'running' ? copy.detecting : (natResult ? copy.redetect : copy.startDetect)}
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
                        {copy.publicMappings(natResult.publicEndpoints.length)}
                      </span>
                    )}
                  </div>
                  <p className="font-kanji text-[11px] text-[var(--text-on-white-2)] leading-snug">
                    {natResult.reason}
                    {(natResult.type === 'symmetric' || natResult.type === 'blocked') && (
                      <span className="block mt-1" style={{ color: 'var(--state-warn-on-light)' }}>
                        {copy.natNeedAssist}
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
                  {copy.cannotFetchStatus}
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
                  {copy.retry}
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
                  <span className="font-kanji text-sm text-[var(--text-on-white)]">{copy.autoIssue}</span>
                  <span
                    className="inline-block px-2 py-0.5 rounded text-[10px] font-kanji text-white"
                    style={{
                      background: !turnStatus.enabled ? 'var(--text-muted-on-light)'
                        : !turnStatus.configured ? 'var(--text-muted-on-light)'
                        : turnStatus.available && autoTurnActive.active ? 'var(--state-success-on-light)' : 'var(--state-warn-on-light)',
                    }}
                  >
                    {!turnStatus.enabled ? copy.statusDisabled
                      : !turnStatus.configured ? copy.statusUnconfigured
                      : !turnStatus.available ? copy.statusUnavailable
                      : autoTurnActive.active ? copy.statusIssued : copy.statusPending}
                  </span>
                </div>

                {autoTurnActive.active && autoTurnActive.expiresAt && (
                  <div className="flex items-center justify-between">
                    <span className="font-kanji text-[11px] text-[var(--text-on-white-2)]">凭证剩余</span>
                    <span className="font-mono text-[11px] text-[var(--text-on-white)]">
                      {copy.credentialRemaining(
                        Math.max(0, Math.floor((autoTurnActive.expiresAt - Date.now()) / 1000)),
                        turnStatus.credentialTtlSec,
                      )}
                    </span>
                  </div>
                )}

                {turnStatus.configured && !turnStatus.available && (
                  <p className="font-kanji text-[10px] leading-snug" style={{ color: 'var(--state-warn-on-light)' }}>
                    {copy.relayTemporarilyUnavailable}
                  </p>
                )}

                {autoTurnActive.lastFailReason && !autoTurnActive.active && (
                  <p className="font-kanji text-[10px] leading-snug" style={{ color: 'var(--state-warn-on-light)' }}>
                    {copy.cannotFetchCredential}
                  </p>
                )}
              </div>
            )}

            <p className="font-kanji text-xs text-[var(--text-on-white-2)] leading-relaxed">
              {copy.intro}
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
                        setIssueError(copy.issueFailed)
                      }
                    } catch (err) {
                      // BUG-026: refreshAutoTurn is not supposed to reject,
                      // but a rejection here used to leave "下发中…" forever.
                      console.warn('[settings] TURN issuance failed', err)
                      setIssueError(copy.issueFailed)
                    } finally {
                      setIssuing(false)
                    }
                  }}
                >
                  {issuing ? copy.issuing : copy.issueCredential}
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
              label={copy.serverAssisted}
              description={copy.serverAssistedDesc}
              checked={turnSettings.enabled}
              onChange={next => setTurnSettings(s => ({ ...s, enabled: next }))}
            />

            {/* Force relay toggle — BUG-008: unusable without an actual relay */}
            <MisakaSwitch
              label={copy.forceRelay}
              description={forceRelayHint}
              labelClassName="font-kanji text-xs text-[var(--text-on-white-2)]"
              checked={turnSettings.forceRelay}
              disabled={!turnAvailable}
              onColor="var(--state-warn)"
              onChange={next => setTurnSettings(s => ({ ...s, forceRelay: next }))}
            />

            {/* 07 P2: manual server form lives under 高级设置 */}
            <div className="rounded-xl" style={{ border: '1px solid var(--border-card)' }}>
              <button
                type="button"
                className="w-full flex items-center justify-between px-3 py-2.5 font-kanji text-xs cursor-pointer"
                style={{
                  border: 'none',
                  background: 'var(--surface-tint)',
                  color: 'var(--text-on-white)',
                  borderRadius: advancedOpen ? '0.75rem 0.75rem 0 0' : '0.75rem',
                }}
                aria-expanded={advancedOpen}
                onClick={() => setAdvancedOpen(o => !o)}
              >
                <span className="font-semibold">{copy.advanced}</span>
                <span aria-hidden="true">{advancedOpen ? '▴' : '▾'}</span>
              </button>

              {advancedOpen && (
                <div className="flex flex-col gap-4 p-3">
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
                            {testingId === s.id ? copy.testing
                              : s.reachable === true ? copy.reachable
                              : s.reachable === false ? copy.unreachable
                              : copy.untested}
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
                            {s.enabled ? copy.disable : copy.enable}
                          </MisakaButton>
                          <MisakaButton variant="pill" size="sm" className="text-[11px] py-1 px-2"
                            onClick={() => handleTest(s)}
                            disabled={testingId === s.id}>
                            {testingId === s.id ? copy.testing : copy.test}
                          </MisakaButton>
                          <MisakaButton variant="pill" size="sm" className="text-[11px] py-1 px-2"
                            onClick={() => handleEdit(s)}>
                            {copy.edit}
                          </MisakaButton>
                          {/* 08 P1: danger action must not share pill weight of 测试/编辑 */}
                          <button
                            type="button"
                            className="font-kanji text-[11px] py-1 px-2 rounded cursor-pointer"
                            style={{
                              border: '1px solid var(--state-danger-on-light)',
                              background: 'transparent',
                              color: 'var(--state-danger-on-light)',
                            }}
                            onClick={() => setPendingDelete(s)}
                          >
                            {copy.delete}
                          </button>
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
                      {editingServer ? copy.editServer : copy.addServer}
                    </div>
                    <div className="flex flex-col gap-1">
                      <label htmlFor={urlId} className="font-kanji text-[11px] text-[var(--text-on-white-2)]">
                        {copy.serverUrl}
                      </label>
                      <input
                        id={urlId}
                        className="misaka-input text-xs"
                        placeholder={copy.serverUrlPlaceholder}
                        value={form.url}
                        onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
                        aria-invalid={form.url.length > 0 && !isValidTurnUrl(form.url) ? true : undefined}
                      />
                      {form.url.length > 0 && !isValidTurnUrl(form.url) && (
                        <p className="font-kanji text-[10px]" style={{ color: 'var(--state-danger-on-light)' }} role="alert">
                          {copy.serverUrlInvalid}
                        </p>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <div className="flex flex-col gap-1 flex-1 min-w-0">
                        <label htmlFor={userId} className="font-kanji text-[11px] text-[var(--text-on-white-2)]">
                          {copy.username}
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
                          {copy.password}
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
                          <MisakaButton variant="primary" size="sm" onClick={handleUpdate} disabled={!isValidTurnUrl(form.url)}>{copy.save}</MisakaButton>
                          <MisakaButton variant="pill" size="sm"
                            onClick={() => { setEditingServer(null); setForm({ url: '', username: '', credential: '' }) }}>
                            {copy.cancel}
                          </MisakaButton>
                        </>
                      ) : (
                        <MisakaButton variant="primary" size="sm" onClick={handleAdd} disabled={!isValidTurnUrl(form.url)}>
                          {copy.add}
                        </MisakaButton>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Sound ─────────────────────────────────────── */}
        {tab === 'sound' && (
          <div
            className="flex flex-col gap-4"
            role="tabpanel"
            id={tabPanelId.sound}
            aria-labelledby={tabId.sound}
          >
            <p className="font-kanji text-xs text-[var(--text-on-white-2)] leading-relaxed">
              {copy.soundIntro}
            </p>
            <MisakaSwitch
              label={copy.soundEnable}
              checked={soundOn}
              onChange={handleSoundToggle}
            />
            <div className="grid grid-cols-3 gap-2">
              {([
                ['scan', copy.soundScan],
                ['complete', copy.soundComplete],
                ['error', copy.soundError],
              ] as const).map(([event, label]) => (
                <MisakaButton key={event} variant="pill" size="sm" onClick={() => playSound(event)}>
                  {label}
                </MisakaButton>
              ))}
            </div>
            <div className="pt-2 border-t" style={{ borderColor: 'var(--border-card)' }}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-kanji text-xs text-[var(--text-on-white-2)]">{copy.fileNotify}</span>
                <MisakaButton
                  variant="pill"
                  size="sm"
                  onClick={async () => {
                    const p = await ensureNotificationPermission()
                    if (p === 'granted') playSound('complete')
                  }}
                >
                  {copy.authorizeNotify}
                </MisakaButton>
              </div>
            </div>
          </div>
        )}

        {/* ── About / Legal ──────────────────────────────── */}
        {tab === 'about' && (
          <div
            className="flex flex-col gap-4"
            role="tabpanel"
            id={tabPanelId.about}
            aria-labelledby={tabId.about}
          >
            <div className="font-kanji text-xs text-[var(--text-on-white-2)] leading-relaxed">
              <p className="mb-2">{copy.aboutCredit}</p>
              <p className="mb-2">{copy.aboutBody}</p>
              <a
                href="https://github.com/12dora/Misaka-Network"
                target="_blank"
                rel="noreferrer"
                className="underline decoration-dotted"
              >
                {copy.github}
              </a>
            </div>
            <div className="flex flex-col gap-2">
              <MisakaButton variant="pill" size="sm" fullWidth
                onClick={() => { modal.requestCloseThen(() => navigate('/tos')) }}>
                {copy.terms}
              </MisakaButton>
              <MisakaButton variant="pill" size="sm" fullWidth
                onClick={() => { modal.requestCloseThen(() => navigate('/privacy')) }}>
                {copy.privacy}
              </MisakaButton>
            </div>
          </div>
        )}
      </div>
    </MisakaDialog>

    {/* 08 P1: nested confirm before deleting a TURN server */}
    {pendingDelete && (
      <MisakaDialog
        title={copy.deleteConfirmTitle}
        description={copy.deleteConfirmBody(pendingDelete.url)}
        onRequestClose={() => setPendingDelete(null)}
        initialFocusRef={keepDeleteRef}
        backdropStyle={{ background: 'rgba(14,42,107,0.7)', backdropFilter: 'blur(6px)', zIndex: 120 }}
        panelClassName="misaka-card w-full max-w-[360px] p-5"
        renderHeader={({ titleId, descriptionId }) => (
          <>
            <h2 id={titleId} className="font-kanji font-bold text-sm text-[var(--text-on-white)] m-0 mb-2">
              {copy.deleteConfirmTitle}
            </h2>
            <p id={descriptionId} className="font-kanji text-xs text-[var(--text-on-white-2)] m-0 mb-4 break-all">
              {copy.deleteConfirmBody(pendingDelete.url)}
            </p>
          </>
        )}
      >
        <div className="flex gap-2">
          <MisakaButton
            ref={keepDeleteRef}
            variant="primary"
            fullWidth
            onClick={() => setPendingDelete(null)}
          >
            {copy.keep}
          </MisakaButton>
          <button
            type="button"
            className="flex-1 font-kanji text-sm py-2 rounded-lg cursor-pointer"
            style={{
              border: '1px solid var(--state-danger-on-light)',
              background: 'transparent',
              color: 'var(--state-danger-on-light)',
            }}
            onClick={() => commitDelete(pendingDelete.id)}
          >
            {copy.confirmDelete}
          </button>
        </div>
      </MisakaDialog>
    )}
    </>
  )
}
