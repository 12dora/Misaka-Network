import { useState, useEffect, useRef } from 'react'
import MisakaCard from '@/components/ui/MisakaCard'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'
import MisakaButton from '@/components/ui/MisakaButton'
import MisakaStatusBadge from '@/components/ui/MisakaStatusBadge'
import MisakaProgressBar from '@/components/ui/MisakaProgressBar'
import AppFooter from '@/components/ui/AppFooter'
import QRModal from '@/components/features/QRModal'
import SettingsModal from '@/components/features/SettingsModal'
import {
  useNetworkStore, isLikelyUnreachable,
  deriveNetworkStatus, networkStatusLabel, peerDisplayStatus,
} from '@/store/network'
import { useAuthStore } from '@/store/auth'
import { appUrl } from '@/lib/appBase'
import { authedFetch, AuthRequiredError } from '@/lib/api'
import { humanizeError } from '@/lib/transfer'
import { ensureNotificationPermission } from '@/lib/notify'
import type { Peer, Transfer, PendingFileItem } from '@/types'

function channelLabel(t: Peer['channelType']) {
  return { direct: '直接信道（局域网）', stun: '标准信道（STUN）', relay: '中继信道（TURN）', ws: '备用信道（WS）' }[t]
}

function formatDuration(ms: number) {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
}

// P2-10: align with SettingsModal — use 1024-base everywhere so the same
// file size doesn't appear as "1.0 MB" in one spot and "1.05 MB" in another.
function formatBytes(b: number) {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`
  if (b >= 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${b} B`
}

// P2-10: auto-scale so a 200 KB/s transfer doesn't read "0.2 MB/s" and look
// broken. KB/s for anything under 1 MB/s, MB/s for higher throughput.
function formatSpeed(bps: number) {
  const Bps = Math.max(0, bps)
  if (Bps >= 1024 * 1024) return `${(Bps / (1024 * 1024)).toFixed(1)} MB/s`
  return `${(Bps / 1024).toFixed(1)} KB/s`
}

function totalFileSize(items: PendingFileItem[]) {
  return items.reduce((sum, item) => sum + item.file.size, 0)
}

function formatIceMeasuredAt(ts?: number) {
  if (!ts) return '未记录'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
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
  // UX-COPY-003: the badge shows peer TRANSPORT state; "正在传输" is a fact
  // about the transfer layer, so it is derived here rather than baked into
  // `Peer.status` by the store.
  const transfers = useNetworkStore(s => s.transfers)
  const signalingStatus = useNetworkStore(s => s.signalingStatus)
  const status = deriveNetworkStatus({ signalingStatus, peers, transfers })
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 mb-1">
        <MisakaKanjiBlock char="点" size="sm" />
        <span className="font-kanji font-bold text-white text-sm">节点雷达</span>
        {/* UX-COPY-003: one honest status, derived from the layer that
            actually explains it (signaling → peer transport → transfer)
            instead of a blanket "已接入". */}
        <span className="font-kanji text-xs text-[var(--text-on-blue-2)] ml-1">
          发现同身份设备 · {networkStatusLabel(status)}
        </span>
      </div>
      <div className="w-12 h-0.5 ml-[calc(1.25rem+0.5rem)]" style={{ background: 'var(--accent-cyan)' }} />

      {peers.length === 0 ? (
        <MisakaCard padding="md" className="text-center">
          <MisakaKanjiBlock char="空" size="lg" className="mx-auto mb-3" />
          <p className="font-kanji text-sm text-[var(--text-on-white)] mb-1">网络中暂无其他实验体</p>
          <p className="font-kanji text-xs text-[var(--text-on-white-2)] mb-4">分享 QR 或链接给另一台设备即可接入</p>
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
              // P1-5: make the radar cards keyboard-operable. Without
              // role="button" and tabIndex the card was reachable only
              // via mouse / touch, locking out screen reader and
              // keyboard-only users entirely. `misaka-focus-ring`
              // re-uses the same focus outline as the passcode inputs.
              role="button"
              tabIndex={0}
              aria-label={`选择御坂 ${peer.nodeId} 号节点`}
              aria-pressed={isSelected}
              className={`misaka-focus-ring cursor-pointer hover:-translate-y-0.5 transition-all duration-150 relative ${isSelected ? 'ring-2 ring-[var(--bg-deep)]' : ''}`}
              style={isSelected ? { background: 'var(--surface-tint)' } : {}}
              onClick={() => onSelect(peer.sessionId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelect(peer.sessionId)
                }
              }}
            >
              {isSelected && (
                <div className="absolute left-0 top-3 bottom-3 w-1 rounded-r" style={{ background: 'var(--bg-deep)' }} />
              )}
              <div className="flex items-center gap-2 mb-2 pl-2">
                <MisakaStatusBadge status={peerDisplayStatus(peer, transfers)} />
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

// ── Delivery status indicator (WhatsApp-style) ────────────────────
function DeliveryStatus({ status, onRetry }: { status?: string; onRetry: () => void }) {
  if (status === 'sending') return (
    <span className="ml-1 text-[10px] opacity-40 select-none" title="发送中">⏳</span>
  )
  if (status === 'sent') return (
    <span className="ml-1 text-[10px] opacity-50 select-none" title="已发送">✓</span>
  )
  if (status === 'delivered') return (
    <span className="ml-1 text-[10px] select-none" style={{ color: 'var(--accent-cyan)' }} title="已送达">✓✓</span>
  )
  if (status === 'failed') return (
    <button
      onClick={onRetry}
      className="ml-1 text-[10px] select-none"
      style={{ color: 'var(--state-danger)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
      title="发送失败，点击重试"
    >↺</button>
  )
  return null
}

// ── Channel Chat ───────────────────────────────────────────────────
function ChannelChat({ peerSessionId }: { peerSessionId: string }) {
  const messages = useNetworkStore(s => s.chatMessages[peerSessionId] ?? [])
  const pendingFiles = useNetworkStore(s => s.pendingFiles[peerSessionId] ?? [])
  const recvTransfers = useNetworkStore(s => s.transfers.filter(t => t.peerSessionId === peerSessionId))
  const sendPendingFile = useNetworkStore(s => s.sendPendingFile)
  const removePendingFile = useNetworkStore(s => s.removePendingFile)
  const clearPendingFiles = useNetworkStore(s => s.clearPendingFiles)
  const retryChatMessage = useNetworkStore(s => s.retryChatMessage)
  const isSending = useNetworkStore(s => s.sendingPeers.has(peerSessionId))
  // UX-COPY-003: the empty-channel line used to claim "[已连接] 人格连接已建立"
  // regardless of whether the peer transport was actually up. Read the real
  // per-peer transport state and say what is true.
  const peerStatus = useNetworkStore(s =>
    s.peers.find(p => p.sessionId === peerSessionId)?.status ?? 'offline')
  const bottomRef = useRef<HTMLDivElement>(null)
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, recvTransfers.length, pendingFiles.length])

  function handleDownload(m: { id: string; fileName?: string; downloadUrl?: string }) {
    if (!m.downloadUrl) return
    const a = document.createElement('a')
    a.href = m.downloadUrl
    a.download = m.fileName ?? 'download'
    a.click()
    // Keep the object URL alive: revoking after a fixed delay used to break the
    // re-download path when the user dismissed the "已下载" state (e.g. tab
    // re-mount). The blob is garbage-collected with the page anyway.
    setDownloadedIds(prev => new Set([...prev, m.id]))
  }

  return (
    <div
      // P2: `misaka-scroll` makes the scrollbar visible and themed so users
      // can tell at a glance whether history is scrollable. Previously the
      // chat container had `scrollbarWidth: 'none'`, hiding any indicator.
      className="misaka-scroll border-t p-4 flex flex-col gap-2"
      // P1-12: previously a hard 200px cap on every viewport. On a 1080p
      // desktop that wastes ~70% of the channel card and forces a tiny
      // scroll for tall conversations; mobile is fine because the screen is
      // short anyway. Use min(svh fraction, fallback px) so we get a
      // reasonable height across sizes without overlapping siblings.
      style={{ borderColor: 'var(--border-card)', maxHeight: 'min(45svh, 360px)', overflowY: 'auto' }}
    >
      <div className="font-kanji text-xs font-semibold text-[var(--text-on-white-2)] mb-1">会话信道</div>
      {messages.length === 0 && recvTransfers.length === 0 && pendingFiles.length === 0 && (
        <div className="font-kanji text-xs text-[var(--text-on-white-2)]">
          <span className="font-mono mr-2 text-[var(--accent-cyan)]">▸</span>
          {peerStatus === 'online' || peerStatus === 'transferring'
            ? '连接成功。现在可以发送消息或文件。'
            : peerStatus === 'reconnecting'
              ? '正在重新连接，稍后即可发送消息或文件。'
              : peerStatus === 'offline'
                ? '尚未连接。请检查网络，或点击上方的重连。'
                : '正在连接…'}
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
                    {/* P1: long filenames get truncated to one line; without a
                        title the user can't recover the full name. */}
                    <div className="truncate text-xs font-semibold" title={m.fileName}>{m.fileName}</div>
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
            // P2: center system notices so they read as out-of-band info
            // rather than a normal chat bubble. Italic alone wasn't enough
            // visual separation against the user/peer bubbles.
            className={`font-kanji text-xs flex ${isSystem ? 'justify-center' : (mine ? 'justify-end' : 'justify-start')}`}
          >
            <div
              className={`rounded-lg px-2.5 py-1.5 ${isSystem ? 'max-w-[90%]' : 'max-w-[80%]'}`}
              style={{
                background: isSystem
                  ? 'rgba(14,42,107,0.05)'
                  : (mine ? 'var(--bg-deep)' : 'var(--surface-tint)'),
                color: isSystem
                  ? 'var(--text-on-white-2)'
                  : (mine ? '#fff' : 'var(--text-on-white)'),
                fontStyle: isSystem ? 'italic' : 'normal',
                // P2: subtle accent on the left edge so system messages are
                // visually distinct without shouting.
                borderLeft: isSystem ? '2px solid var(--accent-cyan)' : undefined,
              }}
            >
              <span className="text-[10px] opacity-70 mr-1">
                {new Date(m.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
              </span>
              {!isSystem && <span className="mr-1 text-[10px] opacity-80">{mine ? '你' : '对方'}:</span>}
              {m.content}
              {mine && m.type === 'text' && (
                <DeliveryStatus status={m.status} onRetry={() => retryChatMessage(peerSessionId, m.id)} />
              )}
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
          {/* P1: same truncate-without-title bug as the file card above. */}
          <span className="truncate flex-1" title={t.fileName}>{t.fileName}</span>
          <span className="text-[10px] text-[var(--text-muted)]">{Math.round(t.progress * 100)}%</span>
        </div>
      ))}
      {pendingFiles.length > 0 && (
        <div
          className="font-kanji text-xs rounded-md p-2"
          style={{ background: 'var(--surface-tint)', border: '1px dashed var(--border-card)' }}
        >
          <div className="flex items-center gap-2 mb-2">
            <span className="font-mono text-[var(--accent-cyan)]">📎</span>
            <div className="flex-1 min-w-0">
              <div className="text-[var(--text-on-white)] font-semibold">待发送 {pendingFiles.length} 个项目</div>
              <div className="text-[10px] text-[var(--text-muted)]">{formatBytes(totalFileSize(pendingFiles))}</div>
            </div>
            <MisakaButton variant="primary" size="sm" className="text-xs py-1 px-3 shrink-0"
              data-testid="send-pending-file"
              disabled={isSending}
              onClick={() => sendPendingFile(peerSessionId)}>
              {isSending ? '发送中…' : '发送'}
            </MisakaButton>
            <MisakaButton variant="pill" size="sm" className="text-xs py-1 px-2 shrink-0"
              onClick={() => clearPendingFiles(peerSessionId)}>
              清空
            </MisakaButton>
          </div>
          <div className="max-h-28 overflow-y-auto space-y-1 pr-1">
            {pendingFiles.map(item => (
              <div key={item.id} className="flex items-center gap-2 rounded px-2 py-1" style={{ background: 'rgba(255,255,255,0.45)' }}>
                <div className="flex-1 min-w-0">
                  {/* P1: long path/name needs a hover tooltip when truncated. */}
                  <div className="truncate text-[var(--text-on-white)]" title={item.displayName}>{item.displayName}</div>
                  <div className="text-[10px] text-[var(--text-muted)]">{formatBytes(item.file.size)}</div>
                </div>
                <button
                  type="button"
                  onClick={() => removePendingFile(peerSessionId, item.id)}
                  className="w-6 h-6 inline-flex items-center justify-center rounded-full text-xs cursor-pointer"
                  style={{ border: 'none', background: 'rgba(14,42,107,0.1)', color: 'var(--text-on-white)' }}
                  aria-label={`移除 ${item.displayName}`}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  )
}

function ChatInput({ peerSessionId }: { peerSessionId: string }) {
  const [text, setText] = useState('')
  const sendChatMessage = useNetworkStore(s => s.sendChatMessage)
  const inputRef = useRef<HTMLInputElement>(null)

  function handleSend() {
    if (!text.trim()) return
    sendChatMessage(peerSessionId, text.trim())
    setText('')
  }

  // P2: on mobile, the soft keyboard slides up and covers the MobileBottomBar
  // which sits directly under this input — leaving the input visible but the
  // text area invisible. Defer one tick so the keyboard has time to push the
  // viewport, then scroll the input back into view.
  function handleFocus() {
    setTimeout(() => {
      inputRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 250)
  }

  return (
    <div
      className="border-t p-3 flex gap-2"
      style={{ borderColor: 'var(--border-card)', borderRadius: '0 0 1rem 1rem' }}
    >
      <input
        ref={inputRef}
        type="text"
        placeholder="输入消息…"
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') handleSend() }}
        onFocus={handleFocus}
        className="misaka-focus-ring flex-1 px-3 py-2 rounded-lg text-sm font-kanji focus:outline-none"
        // Use 16px so iOS Safari doesn't auto-zoom on focus.
        style={{ border: '1px solid var(--border-card)', background: 'var(--surface)', color: 'var(--text-on-white)', fontSize: '16px' }}
        aria-label="聊天输入框"
      />
      <MisakaButton variant="primary" size="sm" onClick={handleSend}>发送</MisakaButton>
    </div>
  )
}

// ── TransferChannel ───────────────────────────────────────────────
function TransferChannel({ selectedPeer, onlinePeerCount, onStageFiles, onSendFilesToAll, onOpenSettings, onEmptyDropAttempt, onForceReconnect, onReconnectPeer, onToast }: {
  selectedPeer: Peer | null
  onlinePeerCount: number
  onStageFiles: (files: File[]) => void
  onSendFilesToAll: (files: File[]) => void
  onOpenSettings: () => void
  onEmptyDropAttempt: () => void
  onForceReconnect: () => void
  onReconnectPeer: (sessionId: string) => Promise<void>
  onToast: (text: string) => void
}) {
  const [isDragOver, setDragOver] = useState(false)
  // P0-1: track per-peer reconnect attempts so the button shows a loading
  // state and the next click while in-flight is a no-op.
  const [reconnecting, setReconnecting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const emptyFanoutInputRef = useRef<HTMLInputElement>(null)

  async function handleReconnectClick() {
    if (!selectedPeer || reconnecting) return
    setReconnecting(true)
    try {
      await onReconnectPeer(selectedPeer.sessionId)
    } catch (e) {
      onToast(`重连失败：${String((e as Error).message ?? e)}`)
    } finally {
      setReconnecting(false)
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) onStageFiles(files)
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (files.length > 0) onStageFiles(files)
    e.target.value = ''
  }

  function handleFolderChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (files.length > 0) onStageFiles(files)
    e.target.value = ''
  }

  async function handleCopyIceDiagnostics() {
    if (!selectedPeer) return
    const lines = [
      `节点: 御坂 ${selectedPeer.nodeId} 号 (#${selectedPeer.sessionId.slice(-4)})`,
      `信道: ${channelLabel(selectedPeer.channelType)}`,
      `ICE路径: ${selectedPeer.icePath ?? '未采集'}`,
      `采集时间: ${formatIceMeasuredAt(selectedPeer.icePathMeasuredAt)}`,
      `状态: ${selectedPeer.status}`,
    ]
    // P1: previously a silent try/catch — users had no idea whether the copy
    // worked, so they clicked again and again. Surface success/failure via
    // the shared page-level toast.
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      onToast('诊断信息已复制到剪贴板')
    } catch {
      onToast('复制失败，请手动选取诊断文本')
    }
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
        onDrop={e => {
          e.preventDefault()
          setDragOver(false)
          // Don't silently swallow the files — tell the user they need to
          // pick a peer first. Previously the styled dashed border invited
          // a drop that was then thrown away.
          const files = Array.from(e.dataTransfer.files)
          if (files.length > 0) onEmptyDropAttempt()
        }}
      >
        <MisakaKanjiBlock char="同" size="xl" className="mb-4" />
        <p className="font-kanji font-bold text-lg text-[var(--text-on-white)] mb-1">从左侧选择目标节点</p>
        <p className="font-kanji text-sm text-[var(--text-on-white-2)] mb-3">选择节点后即可发送文件或消息</p>
        {/* P1-4: with ≥2 online peers, fanout is a useful shortcut even
            before the user picks a target. Previously this entry point
            only existed inside the per-peer drop zone, so a brand-new
            user had to pick + then fanout-from-there. */}
        {onlinePeerCount >= 2 && (
          <>
            <MisakaButton
              variant="pill"
              size="sm"
              className="mt-2"
              onClick={() => emptyFanoutInputRef.current?.click()}
            >
              📡 群发到所有在线节点（{onlinePeerCount}）
            </MisakaButton>
            <input
              ref={emptyFanoutInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? [])
                if (files.length > 0) onSendFilesToAll(files)
                e.target.value = ''
              }}
            />
          </>
        )}
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
        {selectedPeer.icePath && (
          <>
            <div className="font-mono text-[10px] text-[var(--text-muted)] mt-1">
              ICE 路径：{selectedPeer.icePath}
            </div>
            <div className="font-mono text-[10px] text-[var(--text-muted)] mt-0.5">
              采集时间：{formatIceMeasuredAt(selectedPeer.icePathMeasuredAt)}
            </div>
            <div className="mt-1.5">
              <MisakaButton variant="pill" size="sm" className="text-[10px] py-0.5 px-2" onClick={handleCopyIceDiagnostics}>
                复制诊断
              </MisakaButton>
            </div>
          </>
        )}
        {selectedPeer.status === 'reconnecting' && (
          <div className="flex items-center gap-1.5 mt-2 px-2 py-1 rounded text-[10px]" style={{ background: 'rgba(255,193,7,0.12)', color: 'var(--state-warn)' }}>
            <MisakaStatusBadge status="reconnecting" />
            <span className="font-kanji">正在尝试重新协商连接…</span>
            <button
              type="button"
              onClick={onForceReconnect}
              className="ml-auto font-kanji underline decoration-dotted cursor-pointer"
              style={{ background: 'transparent', border: 'none', color: 'var(--state-warn)', padding: 0 }}
            >
              立即重连
            </button>
          </div>
        )}
        {selectedPeer.status === 'offline' && (
          <div className="flex flex-wrap items-center gap-1.5 mt-2 px-2 py-1 rounded text-[10px]" style={{ background: 'rgba(239,68,68,0.1)', color: 'var(--state-danger)' }}>
            <span className="font-kanji">连接已断开 — 请检查网络或开启 TURN 中继</span>
            {/* P0-1: explicit per-peer reconnect so the user doesn't have
                to wait for the auto-recovery cycle (focus/online events).
                Disabled while a previous attempt is in flight. */}
            <button
              type="button"
              onClick={handleReconnectClick}
              disabled={reconnecting}
              className="ml-auto font-kanji underline decoration-dotted cursor-pointer disabled:opacity-50 disabled:cursor-wait"
              style={{ background: 'transparent', border: 'none', color: 'var(--state-danger)', padding: 0 }}
            >
              {reconnecting ? '正在重连…' : '立即重连此节点'}
            </button>
            <button
              type="button"
              onClick={onOpenSettings}
              className="font-kanji underline decoration-dotted cursor-pointer"
              style={{ background: 'transparent', border: 'none', color: 'var(--state-danger)', padding: 0 }}
            >
              打开设置
            </button>
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
        <MisakaButton variant="pill" size="md" className="w-full max-w-[14rem] whitespace-nowrap"
          onClick={() => fileInputRef.current?.click()}>
          📁 选择文件
        </MisakaButton>
        <MisakaButton variant="pill" size="md" className="w-full max-w-[14rem] whitespace-nowrap"
          onClick={() => folderInputRef.current?.click()}>
          🗂 选择文件夹
        </MisakaButton>
        <MisakaButton variant="pill" size="md" className="w-full max-w-[14rem] whitespace-nowrap"
          onClick={() => document.getElementById('fanout-file-input')?.click()}>
          📡 群发文件到全部节点
        </MisakaButton>
        <p className="font-kanji text-xs text-[var(--text-on-white-2)] text-center">支持多选、拖拽多个文件和文件夹队列</p>
        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileChange} />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFolderChange}
          {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
        />
        <input id="fanout-file-input" type="file" multiple className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            if (files.length > 0) onSendFilesToAll(files)
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
function TaskPanel({ transfers, onPause, onResume, onCancel, onResendToPeer }: {
  transfers: Transfer[]
  onPause: (id: string) => void
  onResume: (id: string, peerSessionId: string) => void
  onCancel: (id: string) => void
  onResendToPeer: (peerSessionId: string) => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 mb-1">
        <MisakaKanjiBlock char="流" size="sm" />
        <span className="font-kanji font-bold text-white text-sm">传输面板</span>
        <span className="font-kanji text-xs text-[var(--text-on-blue-2)] ml-1">当前文件任务</span>
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
          <div className="font-kanji text-xs text-[var(--text-on-white-2)] mb-2 truncate" title={`${t.fileName} · ${formatBytes(t.fileSize)}`}>
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
                {/* P1-3: store supports receiver-driven pause/resume — render
                    the same button for inbound transfers so a user can stop
                    a large incoming file without cancelling it outright. */}
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
              {/* P2-12: give the completed card a meaningful next-action so
                  it's not just an inert green badge.
                  - send: original File is held by the engine and may already
                    be garbage-collected; offer "再发文件给此节点" which
                    re-opens the file picker scoped to that peer.
                  - recv: re-download is FSA-path specific (we'd have to hold
                    a Blob/Handle) — show a hint instead so behaviour is
                    consistent regardless of receive backend. */}
              {t.direction === 'send' && (
                <MisakaButton
                  variant="pill"
                  size="sm"
                  className="ml-auto text-xs py-1 px-3"
                  onClick={() => onResendToPeer(t.peerSessionId)}
                >
                  再发文件给此节点
                </MisakaButton>
              )}
              {t.direction === 'recv' && (
                <span className="ml-auto font-kanji text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  已保存
                </span>
              )}
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
          {t.status === 'failed:unsupported' && (
            <>
              <div className="flex items-center gap-2 mt-1">
                <span style={{ color: 'var(--state-danger)' }} className="font-mono text-xs">✗ 浏览器不支持</span>
                <MisakaButton variant="pill" size="sm" className="ml-auto text-xs py-1 px-3" onClick={() => onCancel(t.id)}>✕ 移除</MisakaButton>
              </div>
              {t.error && (
                <div className="mt-1 text-[10px] font-kanji leading-snug" style={{ color: 'var(--text-on-white-2)' }}>
                  {t.error}
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
function MobileBottomBar({
  onShowFiles,
  onShowChannel,
  onShowQR,
}: {
  onShowFiles: () => void
  onShowChannel: () => void
  onShowQR: () => void
}) {
  const items = [
    { kanji: '件', label: '文件', onClick: onShowFiles },
    { kanji: '言', label: '消息', onClick: onShowChannel },
    { kanji: '码', label: 'QR',   onClick: onShowQR },
  ]
  return (
    <div
      className="flex items-center justify-around"
      style={{
        // Reserve home-indicator space on notched iPhones; without this the
        // bar sits on top of the gesture indicator and tap targets clip.
        height: 'calc(96px + env(safe-area-inset-bottom))',
        paddingBottom: 'env(safe-area-inset-bottom)',
        background: 'rgba(14,42,107,0.92)',
        backdropFilter: 'blur(12px)',
        borderTop: '1px solid rgba(255,255,255,0.1)',
      }}
    >
      {items.map(({ kanji, label, onClick }) => (
        <button
          key={kanji}
          onClick={onClick}
          className="flex flex-col items-center gap-1 px-6 py-2 cursor-pointer"
          style={{ border: 'none', background: 'transparent' }}
          aria-label={label}
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

// ── NAT-unreachability banner ────────────────────────────────────
// Surfaces a one-shot, dismissible warning when (a) we've classified
// the local NAT as symmetric AND (b) neither auto nor manual TURN is
// available. Without this, two such peers wait through ~5 ICE restart
// attempts (~30 s) only to land on a generic "连接已断开" banner with
// no actionable hint. The banner deliberately doesn't block any
// interaction — direct LAN peers may still connect just fine.
function NatUnreachableBanner({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null
  return (
    <div
      className="mx-4 mt-4 md:mx-6 md:mt-6 px-4 py-3 rounded-lg flex items-center gap-3 text-sm font-kanji"
      style={{
        background: 'rgba(255, 178, 61, 0.12)',
        border: '1px solid rgba(255, 178, 61, 0.4)',
        color: 'var(--text-on-blue)',
      }}
      role="status"
      aria-live="polite"
    >
      <span aria-hidden="true">⚠</span>
      <div className="flex-1 leading-snug">
        检测到本机为对称 NAT 且 TURN 中继不可用 — 与某些对端可能无法直接建立连接。
      </div>
      <button
        type="button"
        onClick={onOpenSettings}
        className="text-xs underline decoration-dotted cursor-pointer shrink-0"
        style={{ background: 'transparent', border: 'none', color: 'var(--accent-cyan)', padding: 0 }}
      >
        打开设置
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="text-xs cursor-pointer shrink-0"
        aria-label="忽略提示"
        style={{ background: 'transparent', border: 'none', color: 'var(--text-on-blue-2)', padding: '0 4px' }}
      >
        ✕
      </button>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────
export default function Network() {
  const [activeTab, setActiveTab] = useState<TabId>('radar')
  const [showQR, setShowQR]   = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [channelOpenedAt, setChannelOpenedAt] = useState(0)
  // P1-6: once the user has explicitly picked a tab, don't override that
  // choice with the single-peer auto-switch effect below. Previously a user
  // who tapped "任务" while a sole peer existed would be yanked back to
  // "信道" on every peer-list update.
  const userHasTouchedTab = useRef(false)
  const setActiveTabManual = (id: TabId) => {
    userHasTouchedTab.current = true
    setActiveTab(id)
  }
  // Per-peer fanout shortcut from the empty drop-zone path needs a single
  // file picker mounted at the page level so the input element lives across
  // the empty/selected re-render boundary.
  const resendPickerRef = useRef<HTMLInputElement>(null)
  const resendTargetRef = useRef<string | null>(null)

  const auth = useAuthStore()
  const store = useNetworkStore()

  useEffect(() => {
    const token = auth.session?.token
    if (!token) {
      // BUG-001 / BUG-002: the auth session ended (explicit Disconnect, or a
      // 4001/4002 invalidation) — the network epoch must end with it instead
      // of keeping peer connections, keys and transfers alive on a dead
      // identity. destroy() is idempotent.
      useNetworkStore.getState().destroy()
      return
    }
    // init() handles "same token, already running" itself. It used to be
    // skipped whenever the OLD socket still reported wsConnected, which is
    // exactly how a fresh token failed to start a fresh epoch.
    useNetworkStore.getState().init(token)
  }, [auth.session?.token])

  useEffect(() => {
    ensureNotificationPermission().catch(() => {})
  }, [])

  useEffect(() => {
    if (store.peers.length === 1 && !store.selectedSessionId) {
      const onlyPeer = store.peers[0]
      store.selectPeer(onlyPeer.sessionId)
      // P1-6: only auto-switch when the user hasn't already chosen a tab
      // for the current session. The store still gets the selection so the
      // chat/transfer surfaces are wired up when the user does switch.
      if (!userHasTouchedTab.current && activeTab !== 'tasks') {
        setActiveTab('channel')
        setChannelOpenedAt(Date.now())
      }
    }
  }, [store.peers, store.selectedSessionId, activeTab])

  // Shared toast helper — every transient surface (copy results, force-relay
  // hints, error reports) routes through this so the misaka-toast slot is the
  // single source of truth and we don't stack overlapping setTimeouts.
  function showToast(text: string, durationMs = 2400) {
    setToast(text)
    setTimeout(() => setToast(prev => (prev === text ? null : prev)), durationMs)
  }

  async function handleCopyLink() {
    if (!auth.session?.token) return
    try {
      const path = auth.identity.passCode
        ? `/api/qr-token?passCode=${encodeURIComponent(auth.identity.passCode)}`
        : '/api/qr-token'
      const res = await authedFetch(path)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { qrToken: string }
      const params = new URLSearchParams({
        type: 'node',
        id: String(auth.identity.nodeId),
        t: data.qrToken,
      })
      const link = appUrl(`/join?${params.toString()}`)
      await navigator.clipboard.writeText(link)
      showToast('链接已复制到剪贴板')
    } catch (e) {
      if (e instanceof AuthRequiredError) {
        showToast('会话已失效，请重新接入后再试')
      } else {
        showToast(`复制失败：${String(e)}`)
      }
    }
  }

  function handleSelectPeer(sessionId: string) {
    store.selectPeer(sessionId)
    // Picking a peer is the user's explicit "channel-please" gesture, so it's
    // safe (and expected) to switch even if they previously parked on tasks.
    userHasTouchedTab.current = true
    setActiveTab('channel')
    setChannelOpenedAt(Date.now())
  }

  function handleStageFiles(files: File[]) {
    if (!store.selectedSessionId) return
    store.addPendingFiles(store.selectedSessionId, files)
    userHasTouchedTab.current = true
    setActiveTab('channel')
  }

  function handleResendToPeer(peerSessionId: string) {
    resendTargetRef.current = peerSessionId
    resendPickerRef.current?.click()
  }

  async function handleReconnectPeer(sessionId: string) {
    // P0-1: until the store ships a per-peer `reconnectPeer` action we fall
    // back to the shared recoverConnections() path — it iterates every peer
    // and rebuilds offline ones, which covers the case the button targets.
    // TODO(main-agent): wire reconnectPeer(sessionId) for a targeted recover.
    const s = useNetworkStore.getState() as unknown as {
      reconnectPeer?: (sid: string) => Promise<void>
      recoverConnections: () => void
    }
    if (typeof s.reconnectPeer === 'function') {
      await s.reconnectPeer(sessionId)
    } else {
      s.recoverConnections()
    }
  }

  function handleEmptyDropAttempt() {
    showToast('请先在左侧选择一个目标节点，再拖入文件')
  }

  async function handleSendFilesToAll(files: File[]) {
    try {
      await store.sendFilesToAll(files)
    } catch (e) {
      console.error('Fanout send failed:', e)
      showToast(e instanceof Error ? e.message : '群发失败，请稍后再试')
    }
  }

  const peerEntity = store.peers.find(p => p.sessionId === store.selectedSessionId) ?? null
  const onlinePeerCount = store.peers.filter(p => p.status !== 'offline').length

  // P1-3 wiring: pause/resume/cancel must dispatch to the receive-side
  // variants when the transfer is inbound, since the engine state lives in
  // a different bucket. Falls back to the send-side action if the receive
  // variant isn't wired yet — same UX, just less complete.
  function dispatchPause(transferId: string) {
    const t = store.transfers.find(tr => tr.id === transferId)
    if (t?.direction === 'recv') {
      // TODO(main-agent): wire pauseReceiveTransfer(transferId).
      const s = useNetworkStore.getState() as unknown as {
        pauseReceiveTransfer?: (id: string) => void
        pauseTransfer: (id: string) => void
      }
      if (typeof s.pauseReceiveTransfer === 'function') s.pauseReceiveTransfer(transferId)
      else s.pauseTransfer(transferId)
      return
    }
    store.pauseTransfer(transferId)
  }
  function dispatchResume(transferId: string, peerSid: string) {
    const t = store.transfers.find(tr => tr.id === transferId)
    if (t?.direction === 'recv') {
      // TODO(main-agent): wire resumeReceiveTransfer(transferId).
      const s = useNetworkStore.getState() as unknown as {
        resumeReceiveTransfer?: (id: string) => void
        resumeTransfer: (id: string, sid: string) => Promise<void>
      }
      if (typeof s.resumeReceiveTransfer === 'function') s.resumeReceiveTransfer(transferId)
      else void s.resumeTransfer(transferId, peerSid)
      return
    }
    void store.resumeTransfer(transferId, peerSid)
  }
  function dispatchCancel(transferId: string) {
    const t = store.transfers.find(tr => tr.id === transferId)
    if (t?.direction === 'recv') {
      // TODO(main-agent): wire cancelReceiveTransfer(transferId).
      const s = useNetworkStore.getState() as unknown as {
        cancelReceiveTransfer?: (id: string) => void
        cancelTransferAction: (id: string) => void
      }
      if (typeof s.cancelReceiveTransfer === 'function') s.cancelReceiveTransfer(transferId)
      else s.cancelTransferAction(transferId)
      return
    }
    store.cancelTransferAction(transferId)
  }
  // P1-1: precompute the unreachability hint here so both desktop and
  // mobile renders can show the same banner without duplicating the
  // selector.
  const unreachable = isLikelyUnreachable({
    myNatType: store.myNatType,
    autoTurnAvailable: store.autoTurnAvailable,
  })

  return (
    <div className="pt-16 flex flex-col" style={{ background: 'var(--bg-primary)', minHeight: '100dvh' }}>
      {unreachable && (
        <NatUnreachableBanner onOpenSettings={() => setShowSettings(true)} />
      )}
      {/* Desktop 3-column */}
      <div className="hidden md:grid gap-6 p-6" style={{ gridTemplateColumns: 'minmax(220px, 1fr) minmax(0, 2fr) minmax(220px, 1fr)', minHeight: 'calc(100dvh - 64px - 73px)' }}>
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
            onlinePeerCount={onlinePeerCount}
            onStageFiles={handleStageFiles}
            onSendFilesToAll={handleSendFilesToAll}
            onOpenSettings={() => setShowSettings(true)}
            onEmptyDropAttempt={handleEmptyDropAttempt}
            onForceReconnect={() => store.recoverConnections()}
            onReconnectPeer={handleReconnectPeer}
            onToast={showToast}
          />
        </div>
        <div className="overflow-y-auto">
          <TaskPanel
            transfers={store.transfers}
            onPause={dispatchPause}
            onResume={dispatchResume}
            onCancel={dispatchCancel}
            onResendToPeer={handleResendToPeer}
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
              <button key={id} onClick={() => setActiveTabManual(id)}
                aria-pressed={active}
                aria-label={label}
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

        {/*
          The scroll area used to clip its last row behind the 96px MobileBottomBar
          (P0-7): no padding-bottom + no safe-area reservation meant the final
          peer card / chat bubble / transfer row was permanently invisible on
          iPhones with a Home Indicator. We pad by bar-height + safe-area inset.
        */}
        <div
          className="flex-1 overflow-y-auto p-4"
          style={{ paddingBottom: 'calc(96px + env(safe-area-inset-bottom) + 16px)' }}
        >
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
                onlinePeerCount={onlinePeerCount}
                onStageFiles={handleStageFiles}
                onSendFilesToAll={handleSendFilesToAll}
                onOpenSettings={() => setShowSettings(true)}
                onEmptyDropAttempt={handleEmptyDropAttempt}
                onForceReconnect={() => store.recoverConnections()}
                onReconnectPeer={handleReconnectPeer}
                onToast={showToast}
              />
            </div>
          )}
          {activeTab === 'tasks' && (
            <TaskPanel
              transfers={store.transfers}
              onPause={dispatchPause}
              onResume={dispatchResume}
              onCancel={dispatchCancel}
              onResendToPeer={handleResendToPeer}
            />
          )}
        </div>

        <MobileBottomBar
          onShowFiles={() => setActiveTabManual('tasks')}
          onShowChannel={() => setActiveTabManual('channel')}
          onShowQR={() => setShowQR(true)}
        />
      </div>

      {/* P2-11: announce toast via aria-live so screen readers don't miss
          quick feedback (copy result, error, etc). polite + status is the
          right pairing for non-critical, transient messages. The container
          stays mounted as a region so SR users learn its purpose. */}
      <div
        className="misaka-toast-region"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{ position: 'fixed', left: 0, right: 0, bottom: 0, pointerEvents: 'none', zIndex: 120 }}
      >
        {toast && (
          <div
            className="misaka-toast fixed left-1/2 -translate-x-1/2 z-[120] px-4 py-2 rounded-lg text-sm font-kanji shadow-lg"
            style={{ background: 'var(--bg-deep)', color: '#fff', pointerEvents: 'auto' }}
          >
            {toast}
          </div>
        )}
      </div>

      {/* P2-12: shared picker for the "再发文件给此节点" action. Mounted
          once at page level so it survives TransferChannel remounts. */}
      <input
        ref={resendPickerRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          const target = resendTargetRef.current
          resendTargetRef.current = null
          e.target.value = ''
          if (!target || files.length === 0) return
          store.addPendingFiles(target, files)
          if (store.selectedSessionId !== target) store.selectPeer(target)
          userHasTouchedTab.current = true
          setActiveTab('channel')
        }}
      />

      {showQR && (
        <QRModal
          nodeId={auth.identity.nodeId}
          passCode={auth.identity.passCode}
          onClose={() => setShowQR(false)}
        />
      )}
      {showSettings && (
        <SettingsModal onClose={() => setShowSettings(false)} />
      )}
      <AppFooter />
    </div>
  )
}
