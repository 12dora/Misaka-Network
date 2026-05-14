import { useState, useEffect, useRef } from 'react'
import MisakaCard from '@/components/ui/MisakaCard'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'
import MisakaButton from '@/components/ui/MisakaButton'
import MisakaStatusBadge from '@/components/ui/MisakaStatusBadge'
import MisakaProgressBar from '@/components/ui/MisakaProgressBar'
import QRModal from '@/components/features/QRModal'
import { useNetworkStore } from '@/store/network'
import { useAuthStore } from '@/store/auth'
import { apiUrl } from '@/config'
import { humanizeError } from '@/lib/transfer'
import { ensureNotificationPermission } from '@/lib/notify'
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
function NodeRadar({ peers, selected, unreadByPeer, onSelect, onShowQR, onCopyLink }: {
  peers: Peer[]
  selected: string | null
  unreadByPeer: Record<string, { message: number; file: number }>
  onSelect: (sessionId: string) => void
  onShowQR: () => void
  onCopyLink: () => void
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
            <MisakaButton variant="pill" size="sm" fullWidth onClick={onShowQR}>显示我的 QR</MisakaButton>
            <MisakaButton variant="pill" size="sm" fullWidth onClick={onCopyLink}>复制链接</MisakaButton>
          </div>
        </MisakaCard>
      ) : (
        peers.map(peer => {
          const isSelected = selected === peer.sessionId
          const unread = unreadByPeer[peer.sessionId]
          const hasUnread = !!unread && (unread.message > 0 || unread.file > 0)
          // Suffix the last 4 chars of sessionId so multiple devices sharing
          // the same nodeId remain visually distinguishable in the list.
          const sidTag = peer.sessionId.slice(-4)
          return (
            <MisakaCard
              key={peer.sessionId}
              padding="sm"
              className={`cursor-pointer hover:-translate-y-0.5 transition-all duration-150 relative ${isSelected ? 'ring-2 ring-[var(--bg-deep)]' : ''}`}
              style={isSelected ? { background: 'var(--surface-tint)' } : {}}
              onClick={() => onSelect(peer.sessionId)}
            >
              {isSelected && (
                <div className="absolute left-0 top-3 bottom-3 w-1 rounded-r" style={{ background: 'var(--bg-deep)' }} />
              )}
              <div className="flex items-center gap-2 mb-2 pl-2">
                <MisakaStatusBadge status={peer.status} />
                <span className="font-kanji font-bold text-sm text-[var(--text-on-white)] ml-auto">
                  御坂 {peer.nodeId} 号
                  <span className="ml-1 font-mono text-[10px] text-[var(--text-muted)]">#{sidTag}</span>
                </span>
                {hasUnread && (
                  <span
                    className="ml-2 inline-flex items-center justify-center min-w-5 h-5 px-1 rounded-full text-[10px] font-mono text-white"
                    style={{ background: 'var(--state-danger)' }}
                    title={`未读消息 ${unread.message}，未读文件 ${unread.file}`}
                  >
                    {Math.min(99, unread.message + unread.file)}
                  </span>
                )}
              </div>
              <div className="pl-2 space-y-0.5 text-xs text-[var(--text-on-white-2)] font-kanji mb-1">
                <div>▪ {channelLabel(peer.channelType)}</div>
                <div>⏱ {formatDuration(Date.now() - peer.joinedAt)}</div>
              </div>
            </MisakaCard>
          )
        })
      )}
    </div>
  )
}

// ── Channel Chat ───────────────────────────────────────────────────
function ChannelChat({ peerSessionId }: { peerSessionId: string }) {
  const messages = useNetworkStore(s => s.chatMessages[peerSessionId] ?? [])
  const pendingFile = useNetworkStore(s => s.pendingFiles[peerSessionId] ?? null)
  const recvTransfers = useNetworkStore(s => s.transfers.filter(t => t.peerSessionId === peerSessionId))
  const sendPendingFile = useNetworkStore(s => s.sendPendingFile)
  const clearPendingFile = useNetworkStore(s => s.setPendingFile)
  const bottomRef = useRef<HTMLDivElement>(null)
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, recvTransfers.length, pendingFile])

  function handleDownload(m: { id: string; fileName?: string; downloadUrl?: string }) {
    if (!m.downloadUrl) return
    const a = document.createElement('a')
    a.href = m.downloadUrl
    a.download = m.fileName ?? 'download'
    a.click()
    setTimeout(() => { if (m.downloadUrl) URL.revokeObjectURL(m.downloadUrl) }, 500)
    setDownloadedIds(prev => new Set([...prev, m.id]))
  }

  return (
    <div
      className="border-t p-4 flex flex-col gap-2"
      style={{ borderColor: 'var(--border-card)', maxHeight: 200, overflowY: 'auto' }}
    >
      <div className="font-kanji text-xs font-semibold text-[var(--text-on-white-2)] mb-1">会话信道</div>
      {messages.length === 0 && recvTransfers.length === 0 && !pendingFile && (
        <div className="font-kanji text-xs text-[var(--text-on-white-2)]">
          <span className="font-mono mr-2 text-[var(--accent-cyan)]">▸</span>
          [已连接] 人格连接已建立
        </div>
      )}
      {messages.map(m => {
        const mine = m.direction === 'sent'
        const isSystem = m.type === 'system'

        if (m.type === 'file') {
          const alreadyDownloaded = downloadedIds.has(m.id)
          return (
            <div key={m.id} className="font-kanji text-xs flex justify-start">
              <div
                className="max-w-[85%] rounded-lg px-2.5 py-2"
                style={{ background: 'var(--surface-tint)', color: 'var(--text-on-white)' }}
              >
                <div className="flex items-center gap-1 mb-1.5">
                  <span className="text-[10px] opacity-70">
                    {new Date(m.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span className="text-[10px] opacity-80 ml-1">对方:</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm">📎</span>
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-xs font-semibold">{m.fileName}</div>
                    {m.fileSize !== undefined && (
                      <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{formatBytes(m.fileSize)}</div>
                    )}
                  </div>
                  {alreadyDownloaded ? (
                    <span className="text-[10px] font-mono shrink-0" style={{ color: 'var(--state-success)' }}>✓ 已下载</span>
                  ) : (
                    <MisakaButton variant="primary" size="sm" className="text-xs py-0.5 px-2 shrink-0"
                      onClick={() => handleDownload(m)}>
                      ↓ 下载
                    </MisakaButton>
                  )}
                </div>
              </div>
            </div>
          )
        }

        return (
          <div
            key={m.id}
            className={`font-kanji text-xs flex ${mine ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className="max-w-[80%] rounded-lg px-2.5 py-1.5"
              style={{
                background: isSystem
                  ? 'transparent'
                  : (mine ? 'var(--bg-deep)' : 'var(--surface-tint)'),
                color: isSystem
                  ? 'var(--text-on-white-2)'
                  : (mine ? '#fff' : 'var(--text-on-white)'),
                fontStyle: isSystem ? 'italic' : 'normal',
              }}
            >
              <span className="text-[10px] opacity-70 mr-1">
                {new Date(m.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
              </span>
              {!isSystem && <span className="mr-1 text-[10px] opacity-80">{mine ? '你' : '对方'}:</span>}
              {m.content}
            </div>
          </div>
        )
      })}
      {recvTransfers.filter(t => t.direction === 'recv').map(t => (
        <div key={t.id} className="font-kanji text-xs text-[var(--text-on-white)] flex items-center gap-2">
          <span className="font-mono text-[var(--accent-cyan)]">📥</span>
          <span className="text-[var(--text-on-white-2)] text-[10px]">
            {new Date(t.startedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
          </span>
          <span className="truncate flex-1">{t.fileName}</span>
          <span className="text-[10px] text-[var(--text-muted)]">{Math.round(t.progress * 100)}%</span>
        </div>
      ))}
      {pendingFile && (
        <div
          className="font-kanji text-xs rounded-md p-2 flex items-center gap-2"
          style={{ background: 'var(--surface-tint)', border: '1px dashed var(--border-card)' }}
        >
          <span className="font-mono text-[var(--accent-cyan)]">📎</span>
          <div className="flex-1 min-w-0">
            <div className="truncate text-[var(--text-on-white)]">{pendingFile.name}</div>
            <div className="text-[10px] text-[var(--text-muted)]">{formatBytes(pendingFile.size)}</div>
          </div>
          <MisakaButton variant="primary" size="sm" className="text-xs py-1 px-3"
            data-testid="send-pending-file"
            onClick={() => sendPendingFile(peerSessionId)}>
            发送
          </MisakaButton>
          <MisakaButton variant="pill" size="sm" className="text-xs py-1 px-2"
            onClick={() => clearPendingFile(peerSessionId, null)}>
            ✕
          </MisakaButton>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  )
}

function ChatInput({ peerSessionId }: { peerSessionId: string }) {
  const [text, setText] = useState('')
  const sendChatMessage = useNetworkStore(s => s.sendChatMessage)

  function handleSend() {
    if (!text.trim()) return
    sendChatMessage(peerSessionId, text.trim())
    setText('')
  }

  return (
    <div
      className="border-t p-3 flex gap-2"
      style={{ borderColor: 'var(--border-card)', borderRadius: '0 0 1rem 1rem' }}
    >
      <input
        type="text"
        placeholder="输入消息…"
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') handleSend() }}
        className="flex-1 px-3 py-2 rounded-lg text-sm font-kanji focus:outline-none"
        style={{ border: '1px solid var(--border-card)', background: 'var(--surface)', color: 'var(--text-on-white)' }}
      />
      <MisakaButton variant="primary" size="sm" onClick={handleSend}>发送</MisakaButton>
    </div>
  )
}

// ── TransferChannel ───────────────────────────────────────────────
function TransferChannel({ selectedPeer, onStageFile, onSendFileToAll }: {
  selectedPeer: Peer | null
  onStageFile: (file: File) => void
  onSendFileToAll: (file: File) => void
}) {
  const [isDragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) onStageFile(file)
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) onStageFile(file)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // ── No peer selected ────────────────────────────────────────
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
        <p className="font-kanji font-bold text-lg text-[var(--text-on-white)] mb-1">从左侧选择目标节点</p>
        <p className="font-jp text-sm text-[var(--text-on-white-2)] mb-3">対象ノードを選択</p>
      </MisakaCard>
    )
  }

  return (
    <MisakaCard padding="none" className="flex flex-col h-full min-h-[340px]">
      {/* Info bar */}
      <div
        className="px-5 py-3 border-b"
        style={{ background: 'var(--surface-tint)', borderColor: 'var(--border-card)', borderRadius: '1rem 1rem 0 0' }}
      >
        <div className="font-kanji text-sm font-semibold text-[var(--text-on-white)]">
          目标：御坂 {selectedPeer.nodeId} 号
          <span className="ml-1 font-mono text-[10px] text-[var(--text-muted)]">#{selectedPeer.sessionId.slice(-4)}</span>
        </div>
        <div className="font-kanji text-xs text-[var(--text-on-white-2)] mt-0.5">
          {channelLabel(selectedPeer.channelType)} · DTLS + AES-GCM
        </div>
        {selectedPeer.status === 'reconnecting' && (
          <div className="flex items-center gap-1.5 mt-2 px-2 py-1 rounded text-[10px]" style={{ background: 'rgba(255,193,7,0.12)', color: 'var(--state-warn)' }}>
            <MisakaStatusBadge status="reconnecting" />
            <span className="font-kanji">正在尝试重新协商连接…</span>
          </div>
        )}
        {selectedPeer.status === 'offline' && (
          <div className="flex items-center gap-1.5 mt-2 px-2 py-1 rounded text-[10px]" style={{ background: 'rgba(239,68,68,0.1)', color: 'var(--state-danger)' }}>
            <span className="font-kanji">连接已断开 — 请在设置中开启 TURN 中继或检查网络</span>
          </div>
        )}
      </div>

      {/* Drop zone */}
      <div
        className="flex-1 flex flex-col items-center justify-center gap-3 p-6"
        style={isDragOver ? { background: 'var(--surface-tint)' } : {}}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <MisakaButton variant="pill" size="md" className="w-56"
          onClick={() => fileInputRef.current?.click()}>
          📁 拖拽 / 点击选择文件
        </MisakaButton>
        <MisakaButton variant="pill" size="md" className="w-56"
          onClick={() => document.getElementById('fanout-file-input')?.click()}>
          📡 群发文件到全部节点
        </MisakaButton>
        <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileChange} />
        <input id="fanout-file-input" type="file" className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) onSendFileToAll(file)
            e.target.value = ''
          }} />
      </div>

      {/* Channel messages */}
      <ChannelChat peerSessionId={selectedPeer.sessionId} />

      {/* Message input */}
      <ChatInput peerSessionId={selectedPeer.sessionId} />
    </MisakaCard>
  )
}

// ── TaskPanel ─────────────────────────────────────────────────────
function TaskPanel({ transfers, onPause, onResume, onCancel }: {
  transfers: Transfer[]
  onPause: (id: string) => void
  onResume: (id: string, peerSessionId: string) => void
  onCancel: (id: string) => void
}) {
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
          {(t.status === 'transferring' || t.status === 'reconnecting') && (
            <>
              <MisakaProgressBar value={t.progress} className="mb-1.5" />
              <div className="flex justify-between text-[10px] font-mono text-[var(--text-on-white-2)]">
                <span style={{ color: 'var(--accent-cyan)' }}>{Math.round(t.progress * 100)}%</span>
                <span>{formatSpeed(t.speedBps)}</span>
              </div>
              <div className="flex gap-1.5 mt-2">
                <MisakaButton variant="pill" size="sm" className="flex-1 text-xs py-1" onClick={() => onPause(t.id)}>⏸ 暂停</MisakaButton>
                <MisakaButton variant="pill" size="sm" className="flex-1 text-xs py-1" onClick={() => onCancel(t.id)}>✕ 取消</MisakaButton>
              </div>
            </>
          )}
          {t.status === 'paused' && (
            <>
              <MisakaProgressBar value={t.progress} className="mb-1.5 opacity-50" />
              <div className="flex justify-between text-[10px] font-mono text-[var(--text-on-white-2)]">
                <span style={{ color: 'var(--state-warn)' }}>{Math.round(t.progress * 100)}%</span>
                <span style={{ color: 'var(--text-muted)' }}>已暂停</span>
              </div>
              <div className="flex gap-1.5 mt-2">
                <MisakaButton variant="primary" size="sm" className="flex-1 text-xs py-1" onClick={() => onResume(t.id, t.peerSessionId)}>▶ 继续</MisakaButton>
                <MisakaButton variant="pill" size="sm" className="flex-1 text-xs py-1" onClick={() => onCancel(t.id)}>✕ 取消</MisakaButton>
              </div>
            </>
          )}
          {t.status === 'pending' && (
            <div className="flex items-center gap-2 mt-1">
              <span style={{ color: 'var(--text-muted)' }} className="font-mono text-xs">⏳ 等待中</span>
              <MisakaButton variant="pill" size="sm" className="ml-auto text-xs py-1 px-3" onClick={() => onCancel(t.id)}>✕ 取消</MisakaButton>
            </div>
          )}
          {t.status === 'completed' && (
            <div className="flex items-center gap-2 mt-1">
              <span style={{ color: 'var(--state-success)' }} className="font-mono text-xs">✓ 已完成</span>
            </div>
          )}
          {t.status === 'failed' && (
            <>
              <div className="flex items-center gap-2 mt-1">
                <span style={{ color: 'var(--state-danger)' }} className="font-mono text-xs">✗ 失败</span>
                <MisakaButton variant="pill" size="sm" className="ml-auto text-xs py-1 px-3" onClick={() => onResume(t.id, t.peerSessionId)}>重试</MisakaButton>
              </div>
              {t.error && (
                <div className="mt-1 text-[10px] font-kanji" style={{ color: 'var(--text-on-white-2)' }}>
                  {humanizeError(t.error)}
                </div>
              )}
            </>
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
  const [toast, setToast] = useState<string | null>(null)
  const [channelOpenedAt, setChannelOpenedAt] = useState(0)

  const auth = useAuthStore()
  const store = useNetworkStore()

  useEffect(() => {
    if (auth.session?.token && !store.wsConnected) {
      store.init(auth.session.token)
    }
  }, [auth.session?.token])

  useEffect(() => {
    ensureNotificationPermission().catch(() => {})
  }, [])

  useEffect(() => {
    if (store.peers.length === 1 && !store.selectedSessionId) {
      const onlyPeer = store.peers[0]
      store.selectPeer(onlyPeer.sessionId)
      setActiveTab('channel')
      setChannelOpenedAt(Date.now())
    }
  }, [store.peers, store.selectedSessionId])

  async function handleCopyLink() {
    if (!auth.session?.token) return
    try {
      const url = new URL(apiUrl('/api/qr-token'), location.origin)
      if (auth.identity.passCode) url.searchParams.set('passCode', auth.identity.passCode)
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${auth.session.token}` },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { qrToken: string }
      const params = new URLSearchParams({
        type: 'node',
        id: String(auth.identity.nodeId),
        t: data.qrToken,
      })
      const link = `${location.origin}/join?${params.toString()}`
      await navigator.clipboard.writeText(link)
      setToast('链接已复制到剪贴板')
    } catch (e) {
      setToast(`复制失败：${String(e)}`)
    }
    setTimeout(() => setToast(null), 2400)
  }

  function handleSelectPeer(sessionId: string) {
    store.selectPeer(sessionId)
    setActiveTab('channel')
    setChannelOpenedAt(Date.now())
  }

  function handleStageFile(file: File) {
    if (!store.selectedSessionId) return
    store.setPendingFile(store.selectedSessionId, file)
    setActiveTab('channel')
  }

  async function handleSendFileToAll(file: File) {
    try { await store.sendFileToAll(file) }
    catch (e) { console.error('Fanout send failed:', e) }
  }

  const peerEntity = store.peers.find(p => p.sessionId === store.selectedSessionId) ?? null

  return (
    <div className="min-h-screen pt-16" style={{ background: 'var(--bg-primary)' }}>
      {/* Desktop 3-column */}
      <div className="hidden md:grid h-[calc(100vh-64px)] gap-6 p-6" style={{ gridTemplateColumns: '1fr 2fr 1fr' }}>
        <div className="overflow-y-auto">
          <NodeRadar
            peers={store.peers}
            selected={store.selectedSessionId}
            unreadByPeer={store.unreadByPeer}
            onSelect={handleSelectPeer}
            onShowQR={() => setShowQR(true)}
            onCopyLink={handleCopyLink}
          />
        </div>
        <div
          key={peerEntity?.sessionId ?? 'empty'}
          className={channelOpenedAt > 0 ? 'channel-enter' : ''}
        >
          <TransferChannel
            selectedPeer={peerEntity}
            onStageFile={handleStageFile}
            onSendFileToAll={handleSendFileToAll}
          />
        </div>
        <div className="overflow-y-auto">
          <TaskPanel
            transfers={store.transfers}
            onPause={(id) => store.pauseTransfer(id)}
            onResume={(id, sid) => store.resumeTransfer(id, sid)}
            onCancel={(id) => store.cancelTransferAction(id)}
          />
        </div>
      </div>

      {/* Mobile tabs */}
      <div className="md:hidden flex flex-col" style={{ minHeight: 'calc(100svh - 64px)' }}>
        <div className="flex border-b" style={{
          background: 'rgba(14,42,107,0.85)', backdropFilter: 'blur(12px)',
          borderColor: 'rgba(255,255,255,0.12)',
        }}>
          {TABS.map(({ id, kanji, label }) => {
            const active = activeTab === id
            return (
              <button key={id} onClick={() => setActiveTab(id)}
                className="flex-1 flex flex-col items-center justify-center gap-1 py-3 cursor-pointer transition-colors"
                style={{
                  border: 'none', background: 'transparent',
                  borderBottom: active ? '2px solid var(--accent-cyan)' : '2px solid transparent',
                }}>
                <MisakaKanjiBlock char={kanji} size="sm"
                  className={`transition-opacity ${active ? 'opacity-100' : 'opacity-50'}`} />
                <span className="font-kanji text-xs"
                  style={{ color: active ? 'var(--text-on-blue)' : 'var(--text-muted)' }}>
                  {label}
                </span>
              </button>
            )
          })}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {activeTab === 'radar' && (
            <NodeRadar
            peers={store.peers}
            selected={store.selectedSessionId}
            unreadByPeer={store.unreadByPeer}
            onSelect={handleSelectPeer}
            onShowQR={() => setShowQR(true)}
            onCopyLink={handleCopyLink}
            />
          )}
          {activeTab === 'channel' && (
            <div
              key={peerEntity?.sessionId ?? 'empty-mobile'}
              className={channelOpenedAt > 0 ? 'channel-enter' : ''}
            >
              <TransferChannel
                selectedPeer={peerEntity}
                onStageFile={handleStageFile}
                onSendFileToAll={handleSendFileToAll}
              />
            </div>
          )}
          {activeTab === 'tasks' && (
            <TaskPanel
              transfers={store.transfers}
              onPause={(id) => store.pauseTransfer(id)}
              onResume={(id, sid) => store.resumeTransfer(id, sid)}
              onCancel={(id) => store.cancelTransferAction(id)}
            />
          )}
        </div>

        <MobileBottomBar onShowQR={() => setShowQR(true)} />
      </div>

      {toast && (
        <div className="fixed bottom-24 md:bottom-8 left-1/2 -translate-x-1/2 z-[120] px-4 py-2 rounded-lg text-sm font-kanji shadow-lg"
          style={{ background: 'var(--bg-deep)', color: '#fff' }}>
          {toast}
        </div>
      )}

      {showQR && (
        <QRModal
          nodeId={auth.identity.nodeId}
          passCode={auth.identity.passCode}
          onClose={() => setShowQR(false)}
        />
      )}
    </div>
  )
}
