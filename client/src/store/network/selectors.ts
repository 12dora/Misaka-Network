/**
 * Pure selectors and retention helpers.
 *
 * Prune helpers return retired IDs / URLs instead of performing Map or
 * URL.revokeObjectURL side effects — callers (store / download-artifacts /
 * transfer-controller) own those cleanups.
 */

import type { ChannelMessage, NodeStatus, Peer, Transfer } from '@/types'
import { isRelayAllowed } from '@/lib/webrtc'
import { loadTurnSettings } from '@/lib/turn'
import type {
  NetworkState,
  NetworkStatusKey,
  SignalingStatus,
} from './contracts'

export type { SignalingStatus, NetworkStatusKey }

const NETWORK_STATUS_LABELS: Record<NetworkStatusKey, string> = {
  online: '在线',
  transferring: '正在传输',
  connecting: '正在连接',
  reconnecting: '正在重新连接',
  offline: '已离线',
}

export function networkStatusLabel(key: NetworkStatusKey): string {
  return NETWORK_STATUS_LABELS[key]
}

function isActiveTransfer(t: Transfer): boolean {
  return t.status === 'transferring' || t.status === 'pending'
}

export function deriveNetworkStatus(
  s: Pick<NetworkState, 'signalingStatus' | 'peers' | 'transfers'>,
): NetworkStatusKey {
  if (s.signalingStatus === 'idle' || s.signalingStatus === 'offline') return 'offline'
  if (s.signalingStatus === 'reconnecting') return 'reconnecting'
  if (s.signalingStatus === 'connecting') return 'connecting'

  const connectedPeers = s.peers.filter(p => p.status === 'online' || p.status === 'transferring')
  if (connectedPeers.length > 0) {
    const busy = s.transfers.some(t => isActiveTransfer(t)
      && connectedPeers.some(p => p.sessionId === t.peerSessionId))
    return busy ? 'transferring' : 'online'
  }
  if (s.peers.some(p => p.status === 'reconnecting')) return 'reconnecting'
  return 'connecting'
}

export function peerDisplayStatus(peer: Peer, transfers: Transfer[]): NodeStatus {
  if (peer.status !== 'online') return peer.status
  const busy = transfers.some(t => t.peerSessionId === peer.sessionId && isActiveTransfer(t))
  return busy ? 'transferring' : 'online'
}

export function isLikelyUnreachable(
  s: Pick<NetworkState, 'myNatType' | 'autoTurnAvailable'>,
): boolean {
  if (s.myNatType !== 'symmetric') return false
  if (!isRelayAllowed()) return true
  if (s.autoTurnAvailable) return false
  const settings = loadTurnSettings()
  const hasManualTurn = settings.enabled && settings.servers.some(srv => srv.enabled)
  return !hasManualTurn
}

// ── Bounded terminal retention (QUALITY-001) ─────────────────────────
// Pure: no Map deletes, no URL.revoke. Callers apply side effects from
// the returned retired lists.

export const MAX_TERMINAL_TRANSFER_CARDS = 30
export const MAX_CHAT_MESSAGES_PER_PEER = 300

function isTerminalTransfer(t: Transfer): boolean {
  return t.status === 'completed' || t.status === 'failed' || t.status === 'failed:unsupported'
}

export interface PruneTransfersResult {
  kept: Transfer[]
  retiredIds: string[]
}

/**
 * Drop the oldest terminal transfer cards beyond the retention window.
 * Active / pending / paused cards are never touched.
 */
export function selectPrunedTerminalTransfers(transfers: Transfer[]): PruneTransfersResult {
  const terminalCount = transfers.reduce((n, t) => n + (isTerminalTransfer(t) ? 1 : 0), 0)
  if (terminalCount <= MAX_TERMINAL_TRANSFER_CARDS) {
    return { kept: transfers, retiredIds: [] }
  }
  let toDrop = terminalCount - MAX_TERMINAL_TRANSFER_CARDS
  const kept: Transfer[] = []
  const retiredIds: string[] = []
  for (const t of transfers) {
    if (toDrop > 0 && isTerminalTransfer(t)) {
      toDrop--
      retiredIds.push(t.id)
      continue
    }
    kept.push(t)
  }
  return { kept, retiredIds }
}

export interface PruneChatResult {
  kept: ChannelMessage[]
  retiredUrls: string[]
}

/** Bound one peer's chat log; returns object URLs the dropped entries pinned. */
export function selectPrunedChatMessages(msgs: ChannelMessage[]): PruneChatResult {
  if (msgs.length <= MAX_CHAT_MESSAGES_PER_PEER) {
    return { kept: msgs, retiredUrls: [] }
  }
  const dropped = msgs.slice(0, msgs.length - MAX_CHAT_MESSAGES_PER_PEER)
  const retiredUrls: string[] = []
  for (const m of dropped) {
    if (m.downloadUrl) retiredUrls.push(m.downloadUrl)
  }
  return {
    kept: msgs.slice(msgs.length - MAX_CHAT_MESSAGES_PER_PEER),
    retiredUrls,
  }
}
