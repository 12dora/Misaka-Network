import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'
import MisakaButton from '@/components/ui/MisakaButton'
import {
  loadTurnSettings, saveTurnSettings, testTurnServer,
  loadBlocklist, removeBlockedNode,
  fetchTurnStatus, getAutoTurnState,
  type TurnServer, type TurnSettings, type Blocklist,
} from '@/lib/turn'
import { detectNatType, type NatDetectionResult } from '@/lib/nat'
import { isSoundEnabled, setSoundEnabled, subscribeSoundPreference, playSound } from '@/lib/sound'
import { ensureNotificationPermission } from '@/lib/notify'
import { useModalExit } from '@/hooks/useModalExit'

const NAT_TYPE_LABEL: Record<NatDetectionResult['type'], { label: string; color: string }> = {
  open:      { label: '开放（无 NAT）',     color: 'var(--state-success)' },
  cone:      { label: '锥型 NAT（可直连）', color: 'var(--state-success)' },
  symmetric: { label: '对称 NAT（需 TURN）',color: 'var(--state-warn)' },
  blocked:   { label: 'UDP 受限',          color: 'var(--state-warn)' },
  unknown:   { label: '未知',              color: 'var(--text-muted)' },
}

interface Props {
  onClose: () => void
}

type SettingsTab = 'turn' | 'sound' | 'blacklist' | 'about'

interface TurnStatusView {
  enabled: boolean
  configured: boolean
  monthlyBytesUsed: number
  monthlyBytesEffective: number
  monthlyUsageSource: 'cloudflare' | 'pessimistic'
  lastCfSyncError?: string
  monthlyBytesLimit: number
  percentUsed: number
  thresholdPct: number
  killSwitchActive: boolean
  monthKey: string
  credentialTtlSec: number
}

function formatBytes(b: number): string {
  if (b >= 1024 ** 4) return `${(b / 1024 ** 4).toFixed(2)} TB`
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`
  if (b >= 1024)      return `${(b / 1024).toFixed(0)} KB`
  return `${b} B`
}

export default function SettingsModal({ onClose }: Props) {
  const [tab, setTab] = useState<SettingsTab>('turn')
  const [turnSettings, setTurnSettings] = useState<TurnSettings>(loadTurnSettings)
  const [blocklist, setBlocklist] = useState<Blocklist>(loadBlocklist)
  const [editingServer, setEditingServer] = useState<TurnServer | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [soundOn, setSoundOn] = useState(isSoundEnabled)
  const [natResult, setNatResult] = useState<NatDetectionResult | null>(null)
  const [natDetecting, setNatDetecting] = useState(false)
  const [turnStatus, setTurnStatus] = useState<TurnStatusView | null>(null)
  const [autoTurnActive, setAutoTurnActive] = useState(getAutoTurnState())
  const navigate = useNavigate()
  const modal = useModalExit(onClose)

  // Poll server TURN status while the TURN tab is open — cheap (no secrets),
  // gives the user live view of the kill switch + monthly burn.
  useEffect(() => {
    if (tab !== 'turn') return
    let cancelled = false
    const tick = async () => {
      const s = await fetchTurnStatus()
      if (cancelled || !s) return
      setTurnStatus({
        enabled: s.enabled, configured: s.configured,
        monthlyBytesUsed: s.monthlyBytesUsed, monthlyBytesEffective: s.monthlyBytesEffective,
        monthlyUsageSource: s.monthlyUsageSource, lastCfSyncError: s.lastCfSyncError,
        monthlyBytesLimit: s.monthlyBytesLimit,
        percentUsed: s.percentUsed, thresholdPct: s.thresholdPct,
        killSwitchActive: s.killSwitchActive, monthKey: s.monthKey,
        credentialTtlSec: s.credentialTtlSec,
      })
      setAutoTurnActive(getAutoTurnState())
    }
    void tick()
    const id = window.setInterval(tick, 10_000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [tab])

  async function handleDetectNat() {
    setNatDetecting(true)
    try {
      const result = await detectNatType()
      setNatResult(result)
    } finally {
      setNatDetecting(false)
    }
  }

  // Form state
  const [form, setForm] = useState({
    url: '', username: '', credential: '',
  })

  useEffect(() => {
    saveTurnSettings(turnSettings)
  }, [turnSettings])

  useEffect(() => subscribeSoundPreference(setSoundOn), [])

  function handleAdd() {
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
    if (!editingServer) return
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
    setTurnSettings(s => ({ ...s, servers: s.servers.filter(srv => srv.id !== id) }))
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
    setTestingId(server.id)
    const reachable = await testTurnServer(server)
    setTurnSettings(s => ({
      ...s,
      servers: s.servers.map(srv =>
        srv.id === server.id ? { ...srv, reachable, lastTested: Date.now() } : srv,
      ),
    }))
    setTestingId(null)
  }

  function handleRemoveBlocked(nodeId: number) {
    removeBlockedNode(nodeId)
    setBlocklist(loadBlocklist())
  }

  function handleSoundToggle() {
    const next = !soundOn
    setSoundEnabled(next)
    setSoundOn(next)
    if (next) playSound('scan')
  }

  function handleBackdrop(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) modal.requestClose()
  }

  return (
    <div
      className={`fixed inset-0 z-[100] flex items-center justify-center p-4 ${modal.backdropClass}`}
      style={{ background: 'rgba(14,42,107,0.55)', backdropFilter: 'blur(8px)' }}
      onClick={handleBackdrop}
    >
      <div
        className={`relative flex flex-col rounded-2xl ${modal.panelClass}`}
        style={{
          background: 'var(--surface)',
          boxShadow: 'var(--shadow-float)',
          maxWidth: 480,
          width: '100%',
          maxHeight: '80vh',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-6 py-4 border-b"
          style={{ borderColor: 'var(--border-card)' }}
        >
          <div className="flex items-center gap-2">
            <MisakaKanjiBlock char="設" size="sm" />
            <span className="font-kanji font-bold text-sm text-[var(--text-on-white)]">设置</span>
          </div>
          <button
            className="w-7 h-7 flex items-center justify-center rounded-full cursor-pointer hover:opacity-70 transition-opacity"
            style={{ border: 'none', background: 'var(--surface-tint)', color: 'var(--text-on-white)' }}
            onClick={modal.requestClose}
          >
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b" style={{ borderColor: 'var(--border-card)' }}>
          {([
            { id: 'turn' as const, label: '中继' },
            { id: 'sound' as const, label: '音效' },
            { id: 'blacklist' as const, label: '黑名单' },
            { id: 'about' as const, label: '关于' },
          ]).map(t => (
            <button
              key={t.id}
              className="flex-1 py-2.5 text-center font-kanji text-xs cursor-pointer transition-colors"
              style={{
                border: 'none',
                background: 'transparent',
                color: tab === t.id ? 'var(--text-on-white)' : 'var(--text-muted)',
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
                <div className="flex items-center justify-between">
                  <span className="font-kanji text-sm text-[var(--text-on-white)]">网络类型检测</span>
                  <MisakaButton size="sm" onClick={handleDetectNat} disabled={natDetecting}>
                    {natDetecting ? '检测中…' : (natResult ? '重新检测' : '开始检测')}
                  </MisakaButton>
                </div>
                {natResult && (
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span
                        className="inline-block px-2 py-0.5 rounded text-xs font-kanji text-white"
                        style={{ background: NAT_TYPE_LABEL[natResult.type].color }}
                      >
                        {NAT_TYPE_LABEL[natResult.type].label}
                      </span>
                      {natResult.publicEndpoints.length > 0 && (
                        <span className="font-mono text-[11px] text-[var(--text-muted)]">
                          {natResult.publicEndpoints.length} 个公网映射
                        </span>
                      )}
                    </div>
                    <p className="font-kanji text-[11px] text-[var(--text-on-white-2)] leading-snug">
                      {natResult.reason}
                      {(natResult.type === 'symmetric' || natResult.type === 'blocked') && (
                        <span className="block mt-1 text-[var(--state-warn)]">
                          建议在下方启用 TURN 中继，否则与同类网络的对端可能无法直连。
                        </span>
                      )}
                    </p>
                  </div>
                )}
              </div>

              {/* ── Auto TURN status (server-issued, read-only) ─── */}
              {turnStatus && (
                <div
                  className="rounded-lg p-3 flex flex-col gap-2"
                  style={{
                    background: 'var(--surface-tint)',
                    border: `1px solid ${turnStatus.killSwitchActive ? 'var(--state-danger)' : 'var(--border-card)'}`,
                  }}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-kanji text-sm text-[var(--text-on-white)]">服务器自动下发</span>
                    <span
                      className="inline-block px-2 py-0.5 rounded text-[10px] font-kanji text-white"
                      style={{
                        background: turnStatus.killSwitchActive ? 'var(--state-danger)'
                          : !turnStatus.enabled ? 'var(--text-muted)'
                          : !turnStatus.configured ? 'var(--text-muted)'
                          : autoTurnActive.active ? 'var(--state-success)' : 'var(--state-warn)',
                      }}
                    >
                      {turnStatus.killSwitchActive ? '已熔断'
                        : !turnStatus.enabled ? '已停用'
                        : !turnStatus.configured ? '未配置'
                        : autoTurnActive.active ? '已下发' : '待下发'}
                    </span>
                  </div>

                  {autoTurnActive.active && autoTurnActive.expiresAt && (
                    <div className="flex items-center justify-between">
                      <span className="font-kanji text-[11px] text-[var(--text-on-white-2)]">凭证剩余</span>
                      <span className="font-mono text-[11px] text-[var(--text-on-white)]">
                        {Math.max(0, Math.floor((autoTurnActive.expiresAt - Date.now()) / 1000))}s
                        <span className="text-[var(--text-muted)]"> · TTL {turnStatus.credentialTtlSec}s</span>
                      </span>
                    </div>
                  )}

                  {turnStatus.configured && (
                    <>
                      <div className="flex items-center justify-between">
                        <span className="font-kanji text-[11px] text-[var(--text-on-white-2)]">本月用量</span>
                        <span className="font-mono text-[11px] text-[var(--text-on-white)]">
                        {formatBytes(turnStatus.monthlyBytesUsed)} / {formatBytes(turnStatus.monthlyBytesLimit)}
                      </span>
                    </div>
                      <div
                        className="w-full h-1.5 rounded-full overflow-hidden"
                        style={{ background: 'rgba(0,0,0,0.08)' }}
                      >
                        <div
                          className="h-full transition-all"
                          style={{
                            width: `${Math.min(100, turnStatus.percentUsed).toFixed(2)}%`,
                            background: turnStatus.killSwitchActive ? 'var(--state-danger)'
                              : turnStatus.percentUsed >= turnStatus.thresholdPct * 0.9 ? 'var(--state-warn)'
                              : 'var(--state-success)',
                          }}
                        />
                      </div>
                      <p className="font-kanji text-[10px] text-[var(--text-muted)] leading-snug">
                        {turnStatus.killSwitchActive
                          ? `已达 ${turnStatus.thresholdPct}% 熔断阈值，停止下发自动 TURN 直至下月`
                          : `${turnStatus.percentUsed.toFixed(2)}% · 熔断阈值 ${turnStatus.thresholdPct}% · ${turnStatus.monthKey} · ${turnStatus.monthlyUsageSource === 'cloudflare' ? 'CF Analytics' : '本地估算'}`}
                      </p>
                      {turnStatus.lastCfSyncError && (
                        <p className="font-mono text-[10px] text-[var(--state-warn)] leading-snug">
                          CF 同步失败：{turnStatus.lastCfSyncError}
                        </p>
                      )}
                    </>
                  )}

                  {autoTurnActive.lastFailReason && !autoTurnActive.active && (
                    <p className="font-mono text-[10px] text-[var(--state-warn)] leading-snug">
                      原因：{autoTurnActive.lastFailReason}
                    </p>
                  )}
                </div>
              )}

              <p className="font-kanji text-xs text-[var(--text-on-white-2)] leading-relaxed">
                服务器配置好 Cloudflare TURN 后会自动下发短时效凭证；下方手工添加的 TURN 服务器始终生效。
              </p>

              {/* Global toggle */}
              <div className="flex items-center justify-between">
                <span className="font-kanji text-sm text-[var(--text-on-white)]">启用 TURN 中继</span>
                <button
                  className="w-10 h-6 rounded-full transition-colors relative"
                  style={{
                    border: 'none',
                    background: turnSettings.enabled ? 'var(--state-success)' : 'var(--text-muted)',
                  }}
                  onClick={() => setTurnSettings(s => ({ ...s, enabled: !s.enabled }))}
                >
                  <span
                    className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform"
                    style={{ left: turnSettings.enabled ? 'calc(100% - 22px)' : '2px' }}
                  />
                </button>
              </div>

              {/* Force relay toggle */}
              <div className="flex items-center justify-between">
                <span className="font-kanji text-xs text-[var(--text-on-white-2)]">强制使用 TURN（仅测试）</span>
                <button
                  className="w-10 h-6 rounded-full transition-colors relative"
                  style={{
                    border: 'none',
                    background: turnSettings.forceRelay ? 'var(--state-warn)' : 'var(--text-muted)',
                  }}
                  onClick={() => setTurnSettings(s => ({ ...s, forceRelay: !s.forceRelay }))}
                >
                  <span
                    className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform"
                    style={{ left: turnSettings.forceRelay ? 'calc(100% - 22px)' : '2px' }}
                  />
                </button>
              </div>

              {/* Server list */}
              {turnSettings.servers.map(s => (
                <div
                  key={s.id}
                  className="rounded-xl p-3 flex flex-col gap-2"
                  style={{ background: 'var(--surface-tint)' }}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs text-[var(--text-on-white)] truncate max-w-[240px]">{s.url}</span>
                    <span className="font-mono text-[10px]" style={{
                      color: s.reachable === true ? 'var(--state-success)'
                        : s.reachable === false ? 'var(--state-danger)'
                        : 'var(--text-muted)',
                    }}>
                      {testingId === s.id ? '测试中…'
                        : s.reachable === true ? '✓ 可达'
                        : s.reachable === false ? '✗ 不可达'
                        : '未测试'}
                    </span>
                  </div>
                  <div className="flex gap-1.5">
                    <MisakaButton variant="pill" size="sm" className="text-[11px] py-1 px-2"
                      onClick={() => handleToggleServer(s.id)}>
                      {s.enabled ? '禁用' : '启用'}
                    </MisakaButton>
                    <MisakaButton variant="pill" size="sm" className="text-[11px] py-1 px-2"
                      onClick={() => handleTest(s)}>
                      测试
                    </MisakaButton>
                    <MisakaButton variant="pill" size="sm" className="text-[11px] py-1 px-2"
                      onClick={() => handleEdit(s)}>
                      编辑
                    </MisakaButton>
                    <MisakaButton variant="pill" size="sm" className="text-[11px] py-1 px-2"
                      onClick={() => handleDelete(s.id)}>
                      <span style={{ color: 'var(--state-danger)' }}>删除</span>
                    </MisakaButton>
                  </div>
                </div>
              ))}

              {/* Add / Edit form */}
              <div
                className="rounded-xl p-4 flex flex-col gap-3"
                style={{ background: 'var(--surface-tint)' }}
              >
                <div className="font-kanji text-xs font-semibold text-[var(--text-on-white)]">
                  {editingServer ? '编辑 TURN 服务器' : '添加 TURN 服务器'}
                </div>
                <input
                  className="misaka-input text-xs"
                  placeholder="turn:example.com:3478?transport=udp"
                  value={form.url}
                  onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
                />
                <div className="flex gap-2">
                  <input
                    className="misaka-input text-xs flex-1"
                    placeholder="用户名"
                    value={form.username}
                    onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                  />
                  <input
                    className="misaka-input text-xs flex-1"
                    placeholder="密码"
                    type="password"
                    value={form.credential}
                    onChange={e => setForm(f => ({ ...f, credential: e.target.value }))}
                  />
                </div>
                <div className="flex gap-2">
                  {editingServer ? (
                    <>
                      <MisakaButton variant="primary" size="sm" onClick={handleUpdate}>保存</MisakaButton>
                      <MisakaButton variant="pill" size="sm"
                        onClick={() => { setEditingServer(null); setForm({ url: '', username: '', credential: '' }) }}>
                        取消
                      </MisakaButton>
                    </>
                  ) : (
                    <MisakaButton variant="primary" size="sm" onClick={handleAdd} disabled={!form.url}>
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
              <div className="flex items-center justify-between">
                <span className="font-kanji text-sm text-[var(--text-on-white)]">启用操作音效</span>
                <button
                  className="w-10 h-6 rounded-full transition-colors relative"
                  style={{
                    border: 'none',
                    background: soundOn ? 'var(--state-success)' : 'var(--text-muted)',
                  }}
                  onClick={handleSoundToggle}
                >
                  <span
                    className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform"
                    style={{ left: soundOn ? 'calc(100% - 22px)' : '2px' }}
                  />
                </button>
              </div>
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

          {/* ── Blacklist ──────────────────────────────────── */}
          {tab === 'blacklist' && (
            <div className="flex flex-col gap-4">
              <p className="font-kanji text-xs text-[var(--text-on-white-2)] leading-relaxed">
                屏蔽后的节点将无法向你发起连接请求。
              </p>

              {blocklist.blocked.length === 0 ? (
                <div className="text-center py-8">
                  <MisakaKanjiBlock char="空" size="md" className="mx-auto mb-2" />
                  <p className="font-kanji text-xs text-[var(--text-muted)]">黑名单为空</p>
                </div>
              ) : (
                blocklist.blocked.map(b => (
                  <div
                    key={b.nodeId}
                    className="flex items-center justify-between rounded-xl p-3"
                    style={{ background: 'var(--surface-tint)' }}
                  >
                    <div>
                      <div className="font-kanji text-xs font-semibold text-[var(--text-on-white)]">
                        御坂 {b.nodeId} 号
                      </div>
                      <div className="font-kanji text-[10px] text-[var(--text-on-white-2)] mt-0.5">
                        {b.reason} · {new Date(b.blockedAt).toLocaleString()}
                      </div>
                    </div>
                    <MisakaButton variant="pill" size="sm" className="text-[11px] py-1 px-2"
                      onClick={() => handleRemoveBlocked(b.nodeId)}>
                      <span style={{ color: 'var(--state-danger)' }}>解除</span>
                    </MisakaButton>
                  </div>
                ))
              )}
            </div>
          )}

          {/* ── About / Legal ──────────────────────────────── */}
          {tab === 'about' && (
            <div className="flex flex-col gap-4">
              <div className="font-kanji text-xs text-[var(--text-on-white-2)] leading-relaxed">
                <p className="mb-2">© Master Huang · Misaka Network</p>
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
      </div>
    </div>
  )
}
