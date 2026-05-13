import { useState, useEffect, useRef } from 'react'
import MisakaCard from '@/components/ui/MisakaCard'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'
import MisakaButton from '@/components/ui/MisakaButton'
import MisakaStatusBadge from '@/components/ui/MisakaStatusBadge'
import MisakaProgressBar from '@/components/ui/MisakaProgressBar'
import QRModal from '@/components/features/QRModal'
import ReceiveConfirmModal from '@/components/features/ReceiveConfirmModal'
import { useNetworkStore } from '@/store/network'
import { useAuthStore } from '@/store/auth'
import type { Peer, Transfer } from '@/types'

function channelLabel(t: Peer['channelType']) {
  return { direct: '直接信道（局域网）', stun: '标准信道（STUN）', relay: '中继信道（TURN）', ws: '备用信道（WS）' }[t]
}

function formatDuration(ms: number) {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
}

function formatBytes(b: number) {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`
  return `${(b / 1e3).toFixed(0)} KB`
}

function formatSpeed(bps: number) {
  return `${(bps / 1e6).toFixed(1)} MB/s`
}

// ── NodeRadar ─────────────────────────────────────────────────────
function NodeRadar({ peers, selected, onSelect, onSend }: {
  peers: Peer[]
  selected: number | null
  onSelect: (id: number) => void
  onSend: (id: number) => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 mb-1">
        <MisakaKanjiBlock char="点" size="sm" />
        <span className="font-kanji font-bold text-white text-sm">节点雷达</span>
        <span className="font-jp text-xs text-[var(--text-on-blue-2)] ml-1">ノードレーダー</span>
      </div>
      <div className="w-12 h-0.5 ml-[calc(1.25rem+0.5rem)]" style={{ background: 'var(--accent-cyan)' }} />

      {peers.length === 0 ? (
        <MisakaCard padding="md" className="text-center">
          <MisakaKanjiBlock char="空" size="lg" className="mx-auto mb-3" />
          <p className="font-kanji text-sm text-[var(--text-on-white)] mb-1">网络中暂无其他实验体</p>
          <p className="font-jp text-xs text-[var(--text-on-white-2)] mb-4">他にネットワーク参加者なし</p>
          <div className="flex gap-2">
            <MisakaButton variant="pill" size="sm" fullWidth>显示我的 QR</MisakaButton>
            <MisakaButton variant="pill" size="sm" fullWidth>复制链接</MisakaButton>
          </div>
        </MisakaCard>
      ) : (
        peers.map(peer => {
          const isSelected = selected === peer.nodeId
          return (
            <MisakaCard
              key={peer.nodeId}
              padding="sm"
              className={`cursor-pointer hover:-translate-y-0.5 transition-all duration-150 relative ${isSelected ? 'ring-2 ring-[var(--bg-deep)]' : ''}`}
              style={isSelected ? { background: 'var(--surface-tint)' } : {}}
              onClick={() => onSelect(peer.nodeId)}
            >
              {isSelected && (
                <div
                  className="absolute left-0 top-3 bottom-3 w-1 rounded-r"
                  style={{ background: 'var(--bg-deep)' }}
                />
              )}
              <div className="flex items-center gap-2 mb-2 pl-2">
                <MisakaStatusBadge status={peer.status} />
                <span className="font-kanji font-bold text-sm text-[var(--text-on-white)] ml-auto">
                  御坂 {peer.nodeId} 号
                </span>
              </div>
              <div className="pl-2 space-y-0.5 text-xs text-[var(--text-on-white-2)] font-kanji mb-3">
                <div>▪ {channelLabel(peer.channelType)}</div>
                <div>⏱ {formatDuration(Date.now() - peer.joinedAt)}</div>
              </div>
              <div className="flex gap-1.5 pl-2">
                <MisakaButton
                  variant="pill" size="sm" className="flex-1 text-xs py-1.5"
                  onClick={e => { e.stopPropagation(); onSend(peer.nodeId) }}
                >
                  📤 发送
                </MisakaButton>
                <MisakaButton variant="pill" size="sm" className="flex-1 text-xs py-1.5">💬 消息</MisakaButton>
              </div>
            </MisakaCard>
          )
        })
      )}
    </div>
  )
}

// ── TransferChannel ───────────────────────────────────────────────
function TransferChannel({
  selectedPeer,
  incomingRequest,
  onVerifyPassCode,
  onRejectIncoming,
  onSendFile,
}: {
  selectedPeer: Peer | null
  incomingRequest: { fromNodeId: number } | null
  onVerifyPassCode: (code: string) => void
  onRejectIncoming: () => void
  onSendFile: (file: File) => void
}) {
  const [isDragOver, setDragOver] = useState(false)
  const [passCode, setPassCode] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Handle file drop
  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) onSendFile(file)
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) onSendFile(file)
    // Reset so selecting the same file triggers again
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // ── Mode C: Passcode verification ──────────────────────────────
  if (incomingRequest) {
    return (
      <MisakaCard padding="md" className="flex flex-col items-center justify-center h-full min-h-[340px]">
        <MisakaKanjiBlock char="锁" size="lg" className="mb-3" />
        <p className="font-kanji font-bold text-base text-[var(--text-on-white)] mb-1">
          御坂 {incomingRequest.fromNodeId} 号请求接入
        </p>
        <p className="font-jp text-xs text-[var(--text-on-white-2)] mb-4">
          接続リクエスト
        </p>
        <p className="font-kanji text-xs text-[var(--text-on-white-2)] mb-4">
          请输入对方的通行码以建立连接
        </p>
        <input
          type="password"
          inputMode="numeric"
          maxLength={6}
          value={passCode}
          onChange={e => setPassCode(e.target.value.replace(/\D/g, ''))}
          placeholder="000000"
          className="misaka-input mb-3 text-center text-lg tracking-[0.3em] font-mono"
          style={{ maxWidth: 200 }}
          onKeyDown={e => {
            if (e.key === 'Enter' && passCode.length === 6) onVerifyPassCode(passCode)
          }}
        />
        <div className="flex gap-2">
          <MisakaButton
            variant="primary" size="md"
            disabled={passCode.length !== 6}
            onClick={() => onVerifyPassCode(passCode)}
          >
            验证
          </MisakaButton>
          <MisakaButton variant="pill" size="md" onClick={onRejectIncoming}>
            取消
          </MisakaButton>
        </div>
      </MisakaCard>
    )
  }

  // ── Mode A: No peer selected ──────────────────────────────────
  if (!selectedPeer) {
    return (
      <MisakaCard
        padding="none"
        className={`flex flex-col items-center justify-center h-full min-h-[340px] transition-all duration-200 ${isDragOver ? 'ring-2 ring-[var(--accent-cyan)] -translate-y-1' : ''}`}
        style={isDragOver
          ? { background: 'var(--surface-tint)', borderStyle: 'solid', borderColor: 'var(--accent-cyan)' }
          : { borderStyle: 'dashed' }}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false) }}
      >
        <MisakaKanjiBlock char="同" size="xl" className="mb-4" />
        <p className="font-kanji font-bold text-lg text-[var(--text-on-white)] mb-1">拖拽文件到此处</p>
        <p className="font-jp text-sm text-[var(--text-on-white-2)] mb-3">ファイルをドロップ</p>
        <p className="font-kanji text-xs text-[var(--text-muted)] mt-6">── 请先从左侧选择目标节点 ──</p>
      </MisakaCard>
    )
  }

  // ── Mode B: Peer selected ─────────────────────────────────────
  return (
    <MisakaCard padding="none" className="flex flex-col h-full min-h-[340px]">
      {/* Info bar */}
      <div
        className="px-5 py-3 border-b"
        style={{ background: 'var(--surface-tint)', borderColor: 'var(--border-card)', borderRadius: '1rem 1rem 0 0' }}
      >
        <div className="font-kanji text-sm font-semibold text-[var(--text-on-white)]">
          目标：御坂 {selectedPeer.nodeId} 号
        </div>
        <div className="font-kanji text-xs text-[var(--text-on-white-2)] mt-0.5">
          {channelLabel(selectedPeer.channelType)} · DTLS + AES-GCM
        </div>
      </div>

      {/* Drop zone */}
      <div
        className="flex-1 flex flex-col items-center justify-center gap-3 p-6"
        style={isDragOver ? { background: 'var(--surface-tint)' } : {}}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <MisakaButton
          variant="pill" size="md" className="w-56"
          onClick={() => fileInputRef.current?.click()}
        >
          📁 拖拽 / 点击选择文件
        </MisakaButton>
        <MisakaButton variant="pill" size="md" className="w-56">
          📂 选择文件夹
        </MisakaButton>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={handleFileChange}
        />
      </div>

      {/* Channel messages */}
      <div
        className="border-t p-4 flex flex-col gap-2"
        style={{ borderColor: 'var(--border-card)', maxHeight: 160, overflowY: 'auto' }}
      >
        <div className="font-kanji text-xs font-semibold text-[var(--text-on-white-2)] mb-1">会话信道</div>
        <div className="font-kanji text-xs text-[var(--text-on-white-2)]">
          <span className="font-mono mr-2 text-[var(--accent-cyan)]">▸</span>
          [已连接] 人格连接已建立
        </div>
      </div>

      {/* Message input */}
      <div
        className="border-t p-3 flex gap-2"
        style={{ borderColor: 'var(--border-card)', borderRadius: '0 0 1rem 1rem' }}
      >
        <input
          type="text"
          placeholder="输入消息…"
          className="flex-1 px-3 py-2 rounded-lg text-sm font-kanji focus:outline-none"
          style={{ border: '1px solid var(--border-card)', background: 'var(--surface)', color: 'var(--text-on-white)' }}
        />
        <MisakaButton variant="primary" size="sm">发送</MisakaButton>
      </div>
    </MisakaCard>
  )
}

// ── TaskPanel ─────────────────────────────────────────────────────
function TaskPanel({ transfers }: { transfers: Transfer[] }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 mb-1">
        <MisakaKanjiBlock char="流" size="sm" />
        <span className="font-kanji font-bold text-white text-sm">传输面板</span>
        <span className="font-jp text-xs text-[var(--text-on-blue-2)] ml-1">タスクパネル</span>
      </div>
      <div className="w-12 h-0.5 ml-[calc(1.25rem+0.5rem)]" style={{ background: 'var(--accent-cyan)' }} />

      {transfers.map(t => (
        <MisakaCard key={t.id} padding="sm">
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className="text-xs">{t.direction === 'send' ? '📤' : '📥'}</span>
            <span className="font-kanji text-xs font-semibold text-[var(--text-on-white)]">
              {t.direction === 'send' ? '→' : '←'} 御坂 {t.peerNodeId} 号
            </span>
          </div>
          <div className="font-kanji text-xs text-[var(--text-on-white-2)] mb-2 truncate">
            {t.fileName} · {formatBytes(t.fileSize)}
          </div>
          {t.status === 'transferring' && (
            <>
              <MisakaProgressBar value={t.progress} className="mb-1.5" />
              <div className="flex justify-between text-[10px] font-mono text-[var(--text-on-white-2)]">
                <span style={{ color: 'var(--accent-cyan)' }}>{Math.round(t.progress * 100)}%</span>
                <span>{formatSpeed(t.speedBps)}</span>
              </div>
              <div className="flex gap-1.5 mt-2">
                <MisakaButton variant="pill" size="sm" className="flex-1 text-xs py-1">⏸ 暂停</MisakaButton>
                <MisakaButton variant="pill" size="sm" className="flex-1 text-xs py-1">✕ 取消</MisakaButton>
              </div>
            </>
          )}
          {t.status === 'pending' && (
            <div className="flex items-center gap-2 mt-1">
              <span style={{ color: 'var(--text-muted)' }} className="font-mono text-xs">⏳ 等待中</span>
            </div>
          )}
          {t.status === 'completed' && (
            <div className="flex items-center gap-2 mt-1">
              <span style={{ color: 'var(--state-success)' }} className="font-mono text-xs">✓ 已完成</span>
              <MisakaButton variant="pill" size="sm" className="ml-auto text-xs py-1 px-3">打开</MisakaButton>
            </div>
          )}
          {t.status === 'failed' && (
            <div className="flex items-center gap-2 mt-1">
              <span style={{ color: 'var(--state-danger)' }} className="font-mono text-xs">✗ 失败</span>
              <MisakaButton variant="pill" size="sm" className="ml-auto text-xs py-1 px-3">重试</MisakaButton>
            </div>
          )}
        </MisakaCard>
      ))}

      {transfers.length === 0 && (
        <MisakaCard padding="md" className="text-center">
          <p className="font-kanji text-sm text-[var(--text-on-white-2)]">暂无传输任务</p>
        </MisakaCard>
      )}
    </div>
  )
}

// ── Mobile bottom action bar ──────────────────────────────────────
function MobileBottomBar({ onShowQR }: { onShowQR: () => void }) {
  return (
    <div
      className="flex items-center justify-around"
      style={{
        height: 96,
        background: 'rgba(14,42,107,0.92)',
        backdropFilter: 'blur(12px)',
        borderTop: '1px solid rgba(255,255,255,0.1)',
      }}
    >
      {[
        { kanji: '件', label: '文件', onClick: () => {} },
        { kanji: '言', label: '消息', onClick: () => {} },
        { kanji: '码', label: 'QR',   onClick: onShowQR },
      ].map(({ kanji, label, onClick }) => (
        <button
          key={kanji}
          onClick={onClick}
          className="flex flex-col items-center gap-1 px-6 py-2 cursor-pointer"
          style={{ border: 'none', background: 'transparent' }}
        >
          <MisakaKanjiBlock char={kanji} size="sm" />
          <span className="font-kanji text-[11px] text-[var(--text-on-blue-2)]">{label}</span>
        </button>
      ))}
    </div>
  )
}

// ── Mobile Tab Bar ────────────────────────────────────────────────
type TabId = 'radar' | 'channel' | 'tasks'
const TABS: { id: TabId; kanji: string; label: string }[] = [
  { id: 'radar',   kanji: '点', label: '节点' },
  { id: 'channel', kanji: '道', label: '信道' },
  { id: 'tasks',   kanji: '流', label: '任务' },
]

// ── Page ──────────────────────────────────────────────────────────
export default function Network() {
  const [activeTab, setActiveTab] = useState<TabId>('radar')
  const [showQR, setShowQR]   = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)

  const auth = useAuthStore()
  const store = useNetworkStore()

  // Init store on mount
  useEffect(() => {
    if (auth.session?.token && !store.wsConnected) {
      store.init(auth.session.token)
    }
    return () => {
      // Don't destroy on unmount — keep connection alive across tab switches
    }
  }, [auth.session?.token])

  function handleSelectPeer(id: number) {
    store.selectPeer(id)
    setActiveTab('channel')
  }

  async function handleSend(id: number) {
    store.selectPeer(id)
    await store.requestConnection(id)
  }

  async function handleVerify(passCode: string) {
    try {
      setVerifyError(null)
      await store.verifyAndConnect(passCode)
    } catch (e) {
      setVerifyError(String(e))
    }
  }

  function handleRejectIncoming() {
    store.rejectIncoming()
    setVerifyError(null)
  }

  async function handleSendFile(file: File) {
    try {
      await store.sendFile(file)
    } catch (e) {
      console.error('Send failed:', e)
    }
  }

  const peerEntity = store.peers.find(p => p.nodeId === store.selectedPeerId) ?? null

  const receiveModalMeta = store.incomingMeta ? {
    sourceNodeId: store.incomingMeta.fromNodeId,
    fileName: store.incomingMeta.fileName,
    fileSize: store.incomingMeta.fileSize,
    channelType: 'stun' as const,
    fileHash: store.incomingMeta.fileHash,
  } : null

  return (
    <div className="min-h-screen pt-16" style={{ background: 'var(--bg-primary)' }}>

      {/* ── Desktop: 3-column grid ─────────────────────────────────── */}
      <div
        className="hidden md:grid h-[calc(100vh-64px)] gap-6 p-6"
        style={{ gridTemplateColumns: '1fr 2fr 1fr' }}
      >
        <div className="overflow-y-auto">
          <NodeRadar
            peers={store.peers}
            selected={store.selectedPeerId}
            onSelect={handleSelectPeer}
            onSend={handleSend}
          />
        </div>
        <TransferChannel
          selectedPeer={peerEntity}
          incomingRequest={store.incomingRequest}
          onVerifyPassCode={handleVerify}
          onRejectIncoming={handleRejectIncoming}
          onSendFile={handleSendFile}
        />
        <div className="overflow-y-auto">
          <TaskPanel transfers={store.transfers} />
        </div>
      </div>

      {/* ── Mobile: tab layout ────────────────────────────────────── */}
      <div className="md:hidden flex flex-col" style={{ minHeight: 'calc(100svh - 64px)' }}>
        {/* Tab bar */}
        <div
          className="flex border-b"
          style={{
            background: 'rgba(14,42,107,0.85)',
            backdropFilter: 'blur(12px)',
            borderColor: 'rgba(255,255,255,0.12)',
          }}
        >
          {TABS.map(({ id, kanji, label }) => {
            const active = activeTab === id
            return (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className="flex-1 flex flex-col items-center justify-center gap-1 py-3 cursor-pointer transition-colors"
                style={{
                  border: 'none',
                  background: 'transparent',
                  borderBottom: active ? '2px solid var(--accent-cyan)' : '2px solid transparent',
                }}
              >
                <MisakaKanjiBlock
                  char={kanji}
                  size="sm"
                  className={`transition-opacity ${active ? 'opacity-100' : 'opacity-50'}`}
                />
                <span
                  className="font-kanji text-xs"
                  style={{ color: active ? 'var(--text-on-blue)' : 'var(--text-muted)' }}
                >
                  {label}
                </span>
              </button>
            )
          })}
        </div>

        {/* Tab panel */}
        <div className="flex-1 overflow-y-auto p-4">
          {activeTab === 'radar' && (
            <NodeRadar
              peers={store.peers}
              selected={store.selectedPeerId}
              onSelect={handleSelectPeer}
              onSend={handleSend}
            />
          )}
          {activeTab === 'channel' && (
            <TransferChannel
              selectedPeer={peerEntity}
              incomingRequest={store.incomingRequest}
              onVerifyPassCode={handleVerify}
              onRejectIncoming={handleRejectIncoming}
              onSendFile={handleSendFile}
            />
          )}
          {activeTab === 'tasks' && (
            <TaskPanel transfers={store.transfers} />
          )}
        </div>

        {/* Bottom action bar */}
        <MobileBottomBar onShowQR={() => setShowQR(true)} />
      </div>

      {/* Passcode verify error */}
      {verifyError && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[120] px-4 py-2 rounded-lg text-sm font-kanji"
          style={{ background: 'var(--state-danger)', color: '#fff' }}>
          {verifyError}
        </div>
      )}

      {/* Modals */}
      {showQR && (
        <QRModal
          nodeId={auth.identity.nodeId}
          passCode={auth.identity.passCode}
          onClose={() => setShowQR(false)}
        />
      )}
      {receiveModalMeta && !store.incomingRequest && (
        <ReceiveConfirmModal
          transfer={receiveModalMeta}
          onAccept={() => store.acceptTransfer()}
          onReject={() => store.rejectTransfer()}
          onBlock={() => store.blockPeer(receiveModalMeta.sourceNodeId)}
        />
      )}
    </div>
  )
}
