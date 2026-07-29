import { useState, useEffect, useRef } from 'react'
import MisakaCard from '@/components/ui/MisakaCard'
import MisakaKanjiBlock from '@/components/ui/MisakaKanjiBlock'
import MisakaButton from '@/components/ui/MisakaButton'
import MisakaStatusBadge from '@/components/ui/MisakaStatusBadge'
import MisakaProgressBar from '@/components/ui/MisakaProgressBar'
import MisakaDialog from '@/components/ui/MisakaDialog'
import AppFooter from '@/components/ui/AppFooter'
import QRModal from '@/components/features/QRModal'
import SettingsModal from '@/components/features/SettingsModal'
import DownloadArtifactActions from '@/components/features/DownloadArtifactActions'
import {
  useNetworkStore, isLikelyUnreachable,
  deriveNetworkStatus, peerDisplayStatus,
  getTransferDeliveryState,
} from '@/store/network'
import { useAuthStore } from '@/store/auth'
import { appUrl } from '@/lib/appBase'
import { authedFetch, AuthRequiredError } from '@/lib/api'
import { humanizeError } from '@/lib/transfer'
import { ensureNotificationPermission } from '@/lib/notify'
import { scrollIntoViewSafely, useReducedMotion } from '@/hooks/useReducedMotion'
import { formatDurationZhCN } from '@/copy/zh-CN/common'
import { network as netCopy } from '@/copy/zh-CN/network'
import { transfer as xferCopy } from '@/copy/zh-CN/transfer'
import { toUserMessageFromUnknown } from '@/copy/errors'
import type { Peer, Transfer, PendingFileItem } from '@/types'

function channelLabel(t: Peer['channelType']) {
  return netCopy.channel[t]
}

function formatDuration(ms: number) {
  return formatDurationZhCN(ms)
}

function statusLabel(key: ReturnType<typeof deriveNetworkStatus>) {
  return netCopy.status[key]
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
  if (!ts) return netCopy.notRecorded
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
        <span className="font-kanji font-bold text-white text-sm">{netCopy.nodeRadar}</span>
        {/* UX-COPY-003: one honest status, derived from the layer that
            actually explains it (signaling → peer transport → transfer)
            instead of a blanket "已接入". */}
        <span className="font-kanji text-xs text-[var(--text-on-blue-2)] ml-1">
          {netCopy.foundSameIdentity(statusLabel(status))}
        </span>
      </div>
      <div className="w-12 h-0.5 ml-[calc(1.25rem+0.5rem)]" style={{ background: 'var(--accent-cyan)' }} />

      {peers.length === 0 ? (
        <MisakaCard padding="md" className="text-center">
          <MisakaKanjiBlock char="空" size="lg" className="mx-auto mb-3" />
          <p className="font-kanji text-sm text-[var(--text-on-white)] mb-1">{netCopy.noOtherDevices}</p>
          <p className="font-kanji text-xs text-[var(--text-on-white-2)] mb-4">{netCopy.shareToJoin}</p>
          <div className="flex gap-2">
            <MisakaButton variant="pill" size="sm" fullWidth onClick={onShowQR}>{netCopy.showMyQr}</MisakaButton>
            <MisakaButton variant="pill" size="sm" fullWidth onClick={onCopyLink}>{netCopy.copyLink}</MisakaButton>
          </div>
        </MisakaCard>
      ) : (
        peers.map((peer) => {
          const isSelected = selected === peer.sessionId
          const unread = unreadByPeer[peer.sessionId]
          const hasUnread = !!unread && (unread.message > 0 || unread.file > 0)
          // Same nodeId can appear on multiple devices — ordinal distinguishes
          // them in the main flow; full session id lives in tech diagnostics.
          const sameIdPeers = peers.filter(p => p.nodeId === peer.nodeId)
          const deviceOrdinal = sameIdPeers.length > 1
            ? sameIdPeers.findIndex(p => p.sessionId === peer.sessionId) + 1
            : 0
          const displayStatus = peerDisplayStatus(peer, transfers)
          const unreadPart = hasUnread
            ? netCopy.unreadSummary(unread.message, unread.file)
            : undefined
          const ariaName = netCopy.selectDevice(
            peer.nodeId,
            deviceOrdinal > 0 ? netCopy.deviceOrdinal(deviceOrdinal) : undefined,
            netCopy.peerStatus[displayStatus],
            unreadPart,
          )
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
              aria-label={ariaName}
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
                <MisakaStatusBadge status={displayStatus} />
                <span className="font-kanji font-bold text-sm text-[var(--text-on-white)] ml-auto">
                  {netCopy.misakaNumber(peer.nodeId)}
                  {deviceOrdinal > 0 && (
                    <span className="ml-1 font-kanji text-[10px] text-[var(--text-muted-on-light)]">
                      {netCopy.deviceOrdinal(deviceOrdinal)}
                    </span>
                  )}
                </span>
                {hasUnread && (
                  <span
                    className="ml-2 inline-flex items-center justify-center min-w-5 h-5 px-1 rounded-full text-[10px] font-mono font-semibold"
                    data-testid="unread-badge"
                    // 08 P2: white on --state-danger is ~4.05:1 (fails AA at 10px).
                    // Use the contrast-safe fill+text pair (darker danger + white).
                    style={{
                      background: 'var(--state-danger-on-light)',
                      color: '#FFFFFF',
                    }}
                    title={netCopy.unreadSummary(unread.message, unread.file)}
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
    <span className="ml-1 text-[10px] opacity-40 select-none" title={netCopy.delivery.sending}>⏳</span>
  )
  if (status === 'sent') return (
    <span className="ml-1 text-[10px] opacity-50 select-none" title={netCopy.delivery.sent}>✓</span>
  )
  if (status === 'delivered') return (
    <span className="ml-1 text-[10px] select-none" style={{ color: 'var(--accent-cyan)' }} title={netCopy.delivery.delivered}>✓✓</span>
  )
  if (status === 'failed') return (
    <button
      onClick={onRetry}
      className="ml-1 text-[10px] select-none"
      style={{ color: 'var(--state-danger-on-light)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
      title={netCopy.delivery.failedRetry}
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

  useEffect(() => {
    // 08 P2: honour prefers-reduced-motion via the shared helper.
    scrollIntoViewSafely(bottomRef.current)
  }, [messages.length, recvTransfers.length, pendingFiles.length])

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
      <div className="font-kanji text-xs font-semibold text-[var(--text-on-white-2)] mb-1">{netCopy.sessionChannel}</div>
      {messages.length === 0 && recvTransfers.length === 0 && pendingFiles.length === 0 && (
        <div className="font-kanji text-xs text-[var(--text-on-white-2)]">
          <span className="font-mono mr-2 text-[var(--accent-cyan)]">▸</span>
          {peerStatus === 'online' || peerStatus === 'transferring'
            ? netCopy.peerConnected
            : peerStatus === 'reconnecting'
              ? netCopy.peerReconnecting
              : peerStatus === 'offline'
                ? netCopy.peerOffline
                : netCopy.peerConnecting}
        </div>
      )}
      {messages.map(m => {
        const mine = m.direction === 'sent'
        const isSystem = m.type === 'system'

        if (m.type === 'file') {
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
                  <span className="text-[10px] opacity-80 ml-1">{netCopy.peer}：</span>
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
                  {m.downloadUrl && (
                    <DownloadArtifactActions
                      id={m.id}
                      url={m.downloadUrl}
                      fileName={m.fileName ?? 'download'}
                    />
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
              {!isSystem && <span className="mr-1 text-[10px] opacity-80">{mine ? netCopy.you : netCopy.peer}：</span>}
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
              <div className="text-[var(--text-on-white)] font-semibold">{netCopy.pendingItems(pendingFiles.length)}</div>
              <div className="text-[10px] text-[var(--text-muted)]">{formatBytes(totalFileSize(pendingFiles))}</div>
            </div>
            <MisakaButton variant="primary" size="sm" className="text-xs py-1 px-3 shrink-0"
              data-testid="send-pending-file"
              disabled={isSending}
              onClick={() => sendPendingFile(peerSessionId)}>
              {isSending ? netCopy.sending : netCopy.send}
            </MisakaButton>
            <MisakaButton variant="pill" size="sm" className="text-xs py-1 px-2 shrink-0"
              onClick={() => clearPendingFiles(peerSessionId)}>
              {netCopy.clearPending}
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
                  aria-label={netCopy.removeItem(item.displayName)}
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
      // 08 P2: honour prefers-reduced-motion; prefer nearest to avoid jumps.
      scrollIntoViewSafely(inputRef.current, { block: 'nearest' })
    }, 250)
  }

  return (
    <div
      className="border-t p-3 flex gap-2 min-w-0"
      data-testid="chat-input-row"
      style={{ borderColor: 'var(--border-card)', borderRadius: '0 0 1rem 1rem' }}
    >
      <input
        ref={inputRef}
        type="text"
        placeholder={netCopy.chatPlaceholder}
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') handleSend() }}
        onFocus={handleFocus}
        // 08 P1: min-w-0 w-0 flex-1 lets the input shrink inside narrow flex
        // columns (320px phone / 768px three-column threshold).
        className="misaka-focus-ring min-w-0 w-0 flex-1 px-3 py-2 rounded-lg text-sm font-kanji focus:outline-none"
        // Use 16px so iOS Safari doesn't auto-zoom on focus.
        style={{ border: '1px solid var(--border-card)', background: 'var(--surface)', color: 'var(--text-on-white)', fontSize: '16px' }}
        aria-label={netCopy.chatInputLabel}
      />
      <MisakaButton variant="primary" size="sm" className="shrink-0" onClick={handleSend}>{netCopy.send}</MisakaButton>
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
      onToast(toUserMessageFromUnknown(e instanceof Error ? e : String(e)) || netCopy.reconnectFailed)
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
      netCopy.diagLineNode(selectedPeer.nodeId, selectedPeer.sessionId.slice(-4)),
      netCopy.diagLineChannel(channelLabel(selectedPeer.channelType)),
      netCopy.diagLineIce(selectedPeer.icePath ?? netCopy.notRecorded),
      netCopy.diagLineGather(formatIceMeasuredAt(selectedPeer.icePathMeasuredAt)),
      netCopy.diagLineStatus(selectedPeer.status),
    ]
    // P1: previously a silent try/catch — users had no idea whether the copy
    // worked, so they clicked again and again. Surface success/failure via
    // the shared page-level toast.
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      onToast(netCopy.diagnosticsCopied)
    } catch {
      onToast(netCopy.diagnosticsCopyFailed)
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
        <p className="font-kanji font-bold text-lg text-[var(--text-on-white)] mb-1">{netCopy.selectDeviceFirst}</p>
        <p className="font-kanji text-sm text-[var(--text-on-white-2)] mb-3">{netCopy.selectDeviceThenSend}</p>
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
              {netCopy.fanoutAllDevices(onlinePeerCount)}
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
          {netCopy.targetMisaka(selectedPeer.nodeId)}
        </div>
        <div className="font-kanji text-xs text-[var(--text-on-white-2)] mt-0.5">
          {netCopy.connectionMethod}：{channelLabel(selectedPeer.channelType)} · {netCopy.e2eEncrypted}
        </div>
        {/* 07 P2: protocol/ICE/session internals live in a collapsed tech panel. */}
        <details className="mt-2">
          <summary className="font-kanji text-[11px] cursor-pointer" style={{ color: 'var(--text-muted-on-light)' }}>
            {netCopy.techDiagnostics}
          </summary>
          <div className="mt-1.5 space-y-0.5">
            <div className="font-mono text-[10px] text-[var(--text-muted-on-light)]">
              {netCopy.sessionIdLabel(selectedPeer.sessionId)}
            </div>
            <div className="font-mono text-[10px] text-[var(--text-muted-on-light)]">
              {netCopy.channelTypeLabel(selectedPeer.channelType)}
            </div>
            {selectedPeer.icePath && (
              <>
                <div className="font-mono text-[10px] text-[var(--text-muted-on-light)]">
                  {netCopy.icePath}：{selectedPeer.icePath}
                </div>
                <div className="font-mono text-[10px] text-[var(--text-muted-on-light)]">
                  {netCopy.gatherTime}：{formatIceMeasuredAt(selectedPeer.icePathMeasuredAt)}
                </div>
              </>
            )}
            <div className="mt-1.5">
              <MisakaButton variant="pill" size="sm" className="text-[10px] py-0.5 px-2" onClick={handleCopyIceDiagnostics}>
                {netCopy.copyDiagnostics}
              </MisakaButton>
            </div>
          </div>
        </details>
        {selectedPeer.status === 'reconnecting' && (
          <div className="flex items-center gap-1.5 mt-2 px-2 py-1 rounded text-[10px]" style={{ background: 'rgba(255,193,7,0.12)', color: 'var(--state-warn-on-light)' }}>
            <MisakaStatusBadge status="reconnecting" />
            <span className="font-kanji">{netCopy.restoringConnection}</span>
            <button
              type="button"
              onClick={onForceReconnect}
              className="ml-auto font-kanji underline decoration-dotted cursor-pointer"
              style={{ background: 'transparent', border: 'none', color: 'var(--state-warn-on-light)', padding: 0 }}
            >
              {netCopy.reconnectNow}
            </button>
          </div>
        )}
        {selectedPeer.status === 'offline' && (
          <div className="flex flex-wrap items-center gap-1.5 mt-2 px-2 py-1 rounded text-[10px]" style={{ background: 'rgba(239,68,68,0.1)', color: 'var(--state-danger-on-light)' }}>
            <span className="font-kanji">{netCopy.connectionDropped}</span>
            {/* P0-1: explicit per-peer reconnect so the user doesn't have
                to wait for the auto-recovery cycle (focus/online events).
                Disabled while a previous attempt is in flight. */}
            <button
              type="button"
              onClick={handleReconnectClick}
              disabled={reconnecting}
              className="ml-auto font-kanji underline decoration-dotted cursor-pointer disabled:opacity-50 disabled:cursor-wait"
              style={{ background: 'transparent', border: 'none', color: 'var(--state-danger-on-light)', padding: 0 }}
            >
              {reconnecting ? netCopy.reconnecting : netCopy.reconnectThisDevice}
            </button>
            <button
              type="button"
              onClick={onOpenSettings}
              className="font-kanji underline decoration-dotted cursor-pointer"
              style={{ background: 'transparent', border: 'none', color: 'var(--state-danger-on-light)', padding: 0 }}
            >
              {netCopy.openSettings}
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
          {netCopy.selectFile}
        </MisakaButton>
        <MisakaButton variant="pill" size="md" className="w-full max-w-[14rem] whitespace-nowrap"
          onClick={() => folderInputRef.current?.click()}>
          {netCopy.selectFolder}
        </MisakaButton>
        <MisakaButton variant="pill" size="md" className="w-full max-w-[14rem] whitespace-nowrap"
          onClick={() => document.getElementById('fanout-file-input')?.click()}>
          {netCopy.fanoutAllDevicesShort}
        </MisakaButton>
        <p className="font-kanji text-xs text-[var(--text-on-white-2)] text-center">{netCopy.multiSelectHint}</p>
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

/** Statuses for which cancel is still a meaningful, non-destructive-to-done action. */
const CANCELLABLE_STATUSES = new Set<Transfer['status']>([
  'pending',
  'transferring',
  'paused',
  'reconnecting',
])

type PendingCancelSnapshot = {
  id: string
  /** Transfer attempt identity — a re-queued same-id must not match a stale dialog. */
  startedAt: number
  fileName: string
  direction: Transfer['direction']
  progress: number
  status: Transfer['status']
}

export type DisplayTransfer = Transfer & { exiting?: boolean }

/**
 * 08-20 pure transition: keep removed transfer cards briefly as `exiting`
 * so the list does not pop. Exported for unit tests.
 */
export function planTransferDisplay(
  prev: DisplayTransfer[],
  live: Transfer[],
  reducedMotion: boolean,
): { next: DisplayTransfer[]; removedIds: string[] } {
  const nextIds = live.map(t => t.id)
  const prevIds = prev.filter(p => !p.exiting).map(p => p.id)
  const same =
    nextIds.length === prevIds.length &&
    nextIds.every((id, i) => id === prevIds[i])

  if (same) {
    const liveById = new Map(live.map(t => [t.id, t]))
    return {
      next: prev.map(p => {
        if (p.exiting) return p
        const cur = liveById.get(p.id)
        return cur ? { ...cur } : p
      }),
      removedIds: [],
    }
  }

  const removedIds = prevIds.filter(id => !nextIds.includes(id))
  if (reducedMotion || removedIds.length === 0) {
    return { next: live.map(t => ({ ...t })), removedIds }
  }

  const liveCards = live.map(t => ({ ...t }))
  const exiting = prev
    .filter(p => removedIds.includes(p.id) && !p.exiting)
    .map(p => ({ ...p, exiting: true as const }))
  return { next: [...liveCards, ...exiting], removedIds }
}

// ── TaskPanel ─────────────────────────────────────────────────────
function TaskPanel({ transfers, onPause, onResume, onCancel, onResendToPeer, onToast }: {
  transfers: Transfer[]
  onPause: (id: string) => void
  onResume: (id: string, peerSessionId: string) => void
  onCancel: (id: string) => void
  onResendToPeer: (peerSessionId: string) => void
  onToast?: (msg: string) => void
}) {
  // 08 P0: gate destructive cancel behind an explicit confirmation so a
  // mis-tap next to "暂停" cannot throw away a 90%-received multi-GB file.
  // Confirm revalidates identity + cancellable state so a dialog opened at 99%
  // cannot destroy a transfer that completed while the dialog was open.
  const [pendingCancel, setPendingCancel] = useState<PendingCancelSnapshot | null>(null)
  const continueFocusRef = useRef<HTMLButtonElement>(null)
  const reducedMotion = useReducedMotion()
  // 08-20: enter/exit presentation so transfer cards do not pop in/out.
  const [displayTransfers, setDisplayTransfers] = useState<DisplayTransfer[]>(
    () => transfers.map(t => ({ ...t })),
  )
  const prevLiveIdsRef = useRef<string[]>(transfers.map(t => t.id))

  useEffect(() => {
    const nextIds = transfers.map(t => t.id)
    const removed = prevLiveIdsRef.current.filter(id => !nextIds.includes(id))
    prevLiveIdsRef.current = nextIds

    // Pure state update only — schedule exit cleanup outside the updater.
    setDisplayTransfers(prev => planTransferDisplay(prev, transfers, reducedMotion).next)

    if (reducedMotion || removed.length === 0) return
    const timeoutId = window.setTimeout(() => {
      setDisplayTransfers(transfers.map(tr => ({ ...tr })))
    }, 180)
    return () => window.clearTimeout(timeoutId)
  }, [transfers, reducedMotion])

  function requestCancel(t: Transfer) {
    if (!CANCELLABLE_STATUSES.has(t.status)) return
    setPendingCancel({
      id: t.id,
      startedAt: t.startedAt,
      fileName: t.fileName,
      direction: t.direction,
      progress: t.progress,
      status: t.status,
    })
  }

  function isStillCancellable(snapshot: PendingCancelSnapshot, current: Transfer | undefined): boolean {
    if (!current) return false
    if (current.id !== snapshot.id) return false
    if (current.startedAt !== snapshot.startedAt) return false
    return CANCELLABLE_STATUSES.has(current.status)
  }

  // Auto-dismiss when the transfer finishes or is replaced while the dialog is open.
  useEffect(() => {
    if (!pendingCancel) return
    const current = transfers.find(t => t.id === pendingCancel.id)
    if (!isStillCancellable(pendingCancel, current)) {
      setPendingCancel(null)
    }
  }, [transfers, pendingCancel])

  function confirmCancel() {
    if (!pendingCancel) return
    const snapshot = pendingCancel
    const current = transfers.find(t => t.id === snapshot.id)
    setPendingCancel(null)
    if (!isStillCancellable(snapshot, current)) {
      onToast?.(xferCopy.cancelAlreadyFinished)
      return
    }
    onCancel(snapshot.id)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 mb-1">
        <MisakaKanjiBlock char="流" size="sm" />
        <span className="font-kanji font-bold text-white text-sm">{xferCopy.panelTitle}</span>
        <span className="font-kanji text-xs text-[var(--text-on-blue-2)] ml-1">{xferCopy.panelSubtitle}</span>
      </div>
      <div className="w-12 h-0.5 ml-[calc(1.25rem+0.5rem)]" style={{ background: 'var(--accent-cyan)' }} />

      {displayTransfers.map((t, idx) => (
        <MisakaCard
          key={t.id}
          padding="sm"
          data-testid={`transfer-card-${t.id}`}
          data-transfer-exiting={t.exiting ? 'true' : undefined}
          className={
            !reducedMotion && t.exiting
              ? 'activity-exit'
              : !reducedMotion && idx === 0 && !t.exiting
                ? 'activity-enter'
                : undefined
          }
        >
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className="text-xs">{t.direction === 'send' ? '📤' : '📥'}</span>
            <span className="font-kanji text-xs font-semibold text-[var(--text-on-white)]">
              {t.direction === 'send' ? '→' : '←'} {netCopy.misakaNumber(t.peerNodeId)}
            </span>
          </div>
          <div className="font-kanji text-xs text-[var(--text-on-white-2)] mb-2 truncate" title={`${t.fileName} · ${formatBytes(t.fileSize)}`}>
            {t.fileName} · {formatBytes(t.fileSize)}
          </div>
          {(t.status === 'transferring' || t.status === 'reconnecting') && (
            <>
              <MisakaProgressBar
                value={t.progress}
                className="mb-1.5"
                label={xferCopy.progressLabel(t.direction, t.fileName)}
              />
              <div className="flex justify-between text-[10px] font-mono text-[var(--text-on-white-2)]">
                <span style={{ color: 'var(--accent-cyan)' }}>{Math.round(t.progress * 100)}%</span>
                <span>{formatSpeed(t.speedBps)}</span>
              </div>
              <div className="flex gap-1.5 mt-2">
                {/* P1-3: store supports receiver-driven pause/resume — render
                    the same button for inbound transfers so a user can stop
                    a large incoming file without cancelling it outright. */}
                <MisakaButton variant="pill" size="sm" className="flex-1 text-xs py-1" onClick={() => onPause(t.id)}>{xferCopy.pause}</MisakaButton>
                <MisakaButton
                  variant="pill"
                  size="sm"
                  className="flex-1 text-xs py-1"
                  data-testid={`cancel-transfer-${t.id}`}
                  onClick={() => requestCancel(t)}
                >
                  {xferCopy.cancel}
                </MisakaButton>
              </div>
            </>
          )}
          {t.status === 'paused' && (
            <>
              <MisakaProgressBar
                value={t.progress}
                className="mb-1.5 opacity-50"
                label={xferCopy.progressLabel(t.direction, t.fileName)}
              />
              <div className="flex justify-between text-[10px] font-mono text-[var(--text-on-white-2)]">
                <span style={{ color: 'var(--state-warn-on-light)' }}>{Math.round(t.progress * 100)}%</span>
                <span style={{ color: 'var(--text-muted-on-light)' }}>{xferCopy.paused}</span>
              </div>
              <div className="flex gap-1.5 mt-2">
                <MisakaButton variant="primary" size="sm" className="flex-1 text-xs py-1" onClick={() => onResume(t.id, t.peerSessionId)}>{xferCopy.resume}</MisakaButton>
                <MisakaButton
                  variant="pill"
                  size="sm"
                  className="flex-1 text-xs py-1"
                  data-testid={`cancel-transfer-${t.id}`}
                  onClick={() => requestCancel(t)}
                >
                  {xferCopy.cancel}
                </MisakaButton>
              </div>
            </>
          )}
          {t.status === 'pending' && (
            <div className="flex items-center gap-2 mt-1">
              <span style={{ color: 'var(--text-muted-on-light)' }} className="font-mono text-xs">{xferCopy.pending}</span>
              <MisakaButton
                variant="pill"
                size="sm"
                className="ml-auto text-xs py-1 px-3"
                data-testid={`cancel-transfer-${t.id}`}
                onClick={() => requestCancel(t)}
              >
                {xferCopy.cancel}
              </MisakaButton>
            </div>
          )}
          {t.status === 'completed' && (
            <div className="flex flex-wrap items-center gap-2 mt-1">
              <span style={{ color: 'var(--state-success-on-light)' }} className="font-mono text-xs">
                ✓ {t.direction === 'send'
                  ? getTransferDeliveryState(t.id) === 'saved' ? xferCopy.saved : xferCopy.delivered
                  : t.storageMode === 'fsa' ? xferCopy.recvToFsa : xferCopy.recvDone}
              </span>
              {/* 08 P2: wrap so status + resend + waiting-ack don't overflow
                  the ~188px right column at 768px. Keep v2 delivered→saved
                  copy semantics intact. */}
              {t.direction === 'send' && getTransferDeliveryState(t.id) !== 'saved' && (
                <span className="w-full font-kanji text-[10px]" style={{ color: 'var(--state-warn-on-light)' }}>
                  {xferCopy.waitingSaveAck}
                </span>
              )}
              {t.direction === 'send' && (
                <MisakaButton
                  variant="pill"
                  size="sm"
                  className="w-full text-xs py-1 px-3"
                  onClick={() => onResendToPeer(t.peerSessionId)}
                >
                  {xferCopy.resendToPeer}
                </MisakaButton>
              )}
              {t.direction === 'recv' && (
                <span className="w-full font-kanji text-[10px]" style={{ color: 'var(--text-muted-on-light)' }}>
                  {t.storageMode === 'fsa' ? xferCopy.fsaHint : xferCopy.downloadInChat}
                </span>
              )}
            </div>
          )}
          {t.status === 'failed' && (
            <>
              <div className="flex items-center gap-2 mt-1">
                <span style={{ color: 'var(--state-danger-on-light)' }} className="font-mono text-xs">{xferCopy.failed}</span>
                <MisakaButton variant="pill" size="sm" className="ml-auto text-xs py-1 px-3" onClick={() => onResume(t.id, t.peerSessionId)}>{xferCopy.retry}</MisakaButton>
              </div>
              {t.error && (
                <div className="mt-1 text-[10px] font-kanji" style={{ color: 'var(--text-on-white-2)' }}>
                  {toUserMessageFromUnknown(t.error) || humanizeError(t.error)}
                </div>
              )}
            </>
          )}
          {t.status === 'failed:unsupported' && (
            <>
              <div className="flex items-center gap-2 mt-1">
                <span style={{ color: 'var(--state-danger-on-light)' }} className="font-mono text-xs">{xferCopy.unsupported}</span>
                <MisakaButton variant="pill" size="sm" className="ml-auto text-xs py-1 px-3" onClick={() => onCancel(t.id)}>{xferCopy.remove}</MisakaButton>
              </div>
              {t.error && (
                <div className="mt-1 text-[10px] font-kanji leading-snug" style={{ color: 'var(--text-on-white-2)' }}>
                  {toUserMessageFromUnknown(t.error) || humanizeError(t.error)}
                </div>
              )}
            </>
          )}
        </MisakaCard>
      ))}

      {transfers.length === 0 && displayTransfers.every(t => t.exiting) && (
        <MisakaCard padding="md" className="text-center">
          <p className="font-kanji text-sm text-[var(--text-on-white-2)]">{xferCopy.noTasks}</p>
        </MisakaCard>
      )}

      {pendingCancel && (
        <MisakaDialog
          title={xferCopy.cancelConfirmTitle}
          description={xferCopy.cancelConfirmBody({
            fileName: pendingCancel.fileName,
            direction: pendingCancel.direction,
            percent: Math.round(pendingCancel.progress * 100),
          })}
          onRequestClose={() => setPendingCancel(null)}
          initialFocusRef={continueFocusRef}
          panelClassName="relative w-full max-w-sm rounded-2xl p-5"
          panelStyle={{ background: 'var(--surface)', boxShadow: 'var(--shadow-float)' }}
          backdropStyle={{ background: 'rgba(14,42,107,0.55)', backdropFilter: 'blur(8px)' }}
          renderHeader={({ titleId, descriptionId }) => (
            <div className="mb-3">
              <h2 id={titleId} className="font-kanji font-bold text-base text-[var(--text-on-white)] m-0">
                {xferCopy.cancelConfirmTitle}
              </h2>
              <p id={descriptionId} className="font-kanji text-sm text-[var(--text-on-white-2)] mt-2 mb-0 leading-relaxed">
                {xferCopy.cancelConfirmBody({
                  fileName: pendingCancel.fileName,
                  direction: pendingCancel.direction,
                  percent: Math.round(pendingCancel.progress * 100),
                })}
              </p>
              <p
                className="font-kanji text-sm mt-2 mb-0 font-semibold"
                style={{ color: 'var(--state-danger-on-light)' }}
                data-testid="cancel-partial-warning"
              >
                {xferCopy.cancelPartialWarning}
              </p>
            </div>
          )}
        >
          <div className="flex gap-2 mt-4">
            <MisakaButton
              ref={continueFocusRef}
              variant="primary"
              size="sm"
              className="flex-1"
              data-testid="cancel-dialog-continue"
              onClick={() => setPendingCancel(null)}
            >
              {xferCopy.cancelConfirmContinue}
            </MisakaButton>
            <MisakaButton
              variant="pill"
              size="sm"
              className="flex-1"
              data-testid="cancel-dialog-confirm"
              onClick={confirmCancel}
              style={{ color: 'var(--state-danger-on-light)', borderColor: 'var(--state-danger-on-light)' }}
            >
              {xferCopy.cancelConfirmAction}
            </MisakaButton>
          </div>
        </MisakaDialog>
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
    { kanji: '任', label: netCopy.bottomBar.tasks, onClick: onShowFiles },
    { kanji: '道', label: netCopy.bottomBar.channel, onClick: onShowChannel },
    { kanji: '码', label: netCopy.bottomBar.qr, onClick: onShowQR },
  ]
  return (
    <div
      data-testid="mobile-bottom-bar"
      className="flex items-center justify-around shrink-0"
      style={{
        // 08 P1: stay viewport-attached. A sticky bar inside a minHeight-only
        // parent still leaves the document with the footer; fixed + safe-area
        // keeps the bar visible, and the scroll area already pads for it.
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 40,
        height: 'calc(96px + env(safe-area-inset-bottom, 0px))',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
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
  { id: 'radar',   kanji: '点', label: netCopy.tabs.radar },
  { id: 'channel', kanji: '道', label: netCopy.tabs.channel },
  { id: 'tasks',   kanji: '流', label: netCopy.tabs.tasks },
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
        {netCopy.natUnreachable}
      </div>
      <button
        type="button"
        onClick={onOpenSettings}
        className="text-xs underline decoration-dotted cursor-pointer shrink-0"
        style={{ background: 'transparent', border: 'none', color: 'var(--accent-cyan)', padding: 0 }}
      >
        {netCopy.openServerAssisted}
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="text-xs cursor-pointer shrink-0"
        aria-label={netCopy.dismissHint}
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
      const res = await authedFetch('/api/qr-token', { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { qrToken: string }
      const params = new URLSearchParams({
        type: 'node',
        id: String(auth.identity.nodeId),
        t: data.qrToken,
      })
      const link = appUrl(`/join?${params.toString()}`)
      await navigator.clipboard.writeText(link)
      showToast(netCopy.linkCopied)
    } catch (e) {
      if (e instanceof AuthRequiredError) {
        showToast(toUserMessageFromUnknown('session expired'))
      } else {
        showToast(toUserMessageFromUnknown(e instanceof Error ? e : String(e)))
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
    await useNetworkStore.getState().reconnectPeer(sessionId)
  }

  function handleEmptyDropAttempt() {
    showToast(netCopy.emptyDrop)
  }

  async function handleSendFilesToAll(files: File[]) {
    try {
      await store.sendFilesToAll(files)
    } catch (e) {
      console.error('Fanout send failed:', e)
      showToast(toUserMessageFromUnknown(e instanceof Error ? e : String(e)) || netCopy.fanoutFailed)
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
      useNetworkStore.getState().pauseReceiveTransfer(transferId)
      return
    }
    store.pauseTransfer(transferId)
  }
  // BUG-019: "重试" / "继续" used to be fire-and-forget. The store flipped the
  // card to 转输中 and then hit a silent early return whenever the source File,
  // the persisted record or the DataChannel was gone, leaving a permanently
  // fake in-progress card. The store now validates preconditions BEFORE the
  // status change and rejects with a structured `TransferResumeError`; this
  // call site awaits it and surfaces the reason.
  function dispatchResume(transferId: string, peerSid: string) {
    const t = store.transfers.find(tr => tr.id === transferId)
    const run = t?.direction === 'recv'
      ? useNetworkStore.getState().resumeReceiveTransfer(transferId)
      : store.resumeTransfer(transferId, peerSid)
    void Promise.resolve(run).catch((e: unknown) => {
      console.error('Resume transfer failed:', e)
      showToast(toUserMessageFromUnknown(e instanceof Error ? e : String(e)) || netCopy.cannotResume)
    })
  }
  function dispatchCancel(transferId: string) {
    const t = store.transfers.find(tr => tr.id === transferId)
    if (t?.direction === 'recv') {
      useNetworkStore.getState().cancelReceiveTransfer(transferId)
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
    <div className="pt-nav flex flex-col" style={{ background: 'var(--bg-primary)', minHeight: '100dvh' }} data-testid="network-page">
      {unreachable && (
        <NatUnreachableBanner onOpenSettings={() => setShowSettings(true)} />
      )}
      {/* Desktop 3-column — 08 P1: use --nav-h-total, never bare 64px. */}
      <div className="hidden md:grid gap-6 p-6" style={{ gridTemplateColumns: 'minmax(220px, 1fr) minmax(0, 2fr) minmax(220px, 1fr)', minHeight: 'calc(100dvh - var(--nav-h-total) - 73px)' }}>
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
            onToast={showToast}
          />
        </div>
      </div>

      {/* Mobile tabs — 08 P1: --nav-h-total accounts for safe-area inset.
          Bound height so the bottom bar cannot scroll out of the viewport
          with the document (sticky alone is not enough when the parent only
          has minHeight and the footer sits below). */}
      <div className="md:hidden flex flex-col min-h-0" style={{ height: 'calc(100svh - var(--nav-h-total))' }}>
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
              onToast={showToast}
            />
          )}
        </div>

        <MobileBottomBar
          onShowFiles={() => setActiveTabManual('tasks')}
          onShowChannel={() => setActiveTabManual('channel')}
          onShowQR={() => setShowQR(true)}
        />
      </div>

      {/* P2-11 / 08 P2: reuse .misaka-notify so toast sits below dialogs
          (z=90) and hides under body[data-dialog-open]. */}
      {toast && (
        <div
          className="misaka-notify px-4 py-2 rounded-lg text-sm font-kanji shadow-lg"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid="network-toast"
          style={{ background: 'var(--bg-deep)', color: '#fff' }}
        >
          {toast}
        </div>
      )}

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
