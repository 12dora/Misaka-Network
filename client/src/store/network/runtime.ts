/**
 * Network store runtime (Wave 4d finish). Composition root:
 * construct store, wire StorePort + deps, re-export public surfaces.
 *
 * Domain logic lives in controllers under this folder. No module below
 * store.ts imports the Zustand singleton.
 */
import { create } from 'zustand'
import { getDetectedNatType } from '@/lib/nat'
import type {
  NetworkState,
  SignalingStatus,
  NetworkStatusKey,
  EpochTransferTeardown,
  ResumeFailureCode,
} from './contracts'
import {
  PartialFanoutError,
  TransferResumeError,
} from './contracts'
import { bindStorePort } from './store-access'
import { bindDeps } from './deps'
import {
  outgoingQueue,
  queuedMessageIds,
  seenInboundChatIds,
  failPendingMessages,
} from './chat-controller'
import {
  pendingDurableAcks,
  sendingFiles,
  setSendingFileForTests,
  shortIdToTransferId,
  deliveredTransfers,
  transferSpeedSamples,
  transferDelivery,
  getTransferDeliveryState,
  pruneTerminalTransferCards,
  checkResumePreconditions,
} from './transfer-controller'
import {
  installForegroundRecovery,
  installTurnConfigPropagation,
  startNatAndTurnProbes,
  recoverConnections,
  renegotiateOrphanPeers,
  propagateIceConfig,
  pendingIceMigration,
} from './connectivity-controller'
import {
  iceRestartRetryTimers, iceRestarting, iceRestartAttempts,
  initialEncryptedSessionRebuilds,
  attemptIceRestart, handleIceStateChange, scheduleInitialIceRecovery,
  clearInitialIceRecovery, clearDisconnectedTimer,
} from './ice-recovery'
import { setupDataChannel } from './data-channel-router'
import {
  peerTaskQueues,
  peerSignalingIncarnations,
  peerLocalOfferTokens,
  pendingRemoteIce,
  negState,
  beginLocalOffer,
  invalidatePendingLocalOffer,
  isLocalOfferCurrent,
  peerSignalingIncarnation,
  invalidatePeerSignalingIncarnation,
  captureSignalReceipt,
  enqueuePeerTask,
  sendLocalOffer,
  isPolite,
  handleRemoteSDP,
  handleRemoteICE,
  handleRemoteICEEnd,
  getPendingSignalingQueueCount,
  getPendingRemoteIceCount,
  getPendingRemoteIceCandidateCount,
  getPendingRemoteIceReservationCount,
  getPendingRemoteIceOverflowState,
  clearPeerNegotiationState,
  clearAllNegotiationState,
  type PendingRemoteIceOverflowState,
} from './negotiation-controller'
import {
  peerConnections,
  dataChannels,
  transferLanes,
  configuredDataChannels,
  ecdhResolvers,
  connectingPeers,
  remoteInitiatingPeers,
  primaryChannelResolvers,
  peerGenerations,
  initiatingPeers,
  peerGeneration,
  bumpPeerGeneration,
  isCurrentGeneration,
  captureGenerationAttempt,
  capturePeerConnectionAttempt,
  isPeerGenerationAttemptCurrent,
  isPeerConnectionAttemptCurrent,
  notifyPrimaryChannel,
  ensureConnected,
  ensureTransferLanes,
  initiateWebRTC,
  abandonPeerConnection,
  installIceCandidateHandler,
  cleanupPeerConnection,
} from './peer-runtime'
import {
  currentToken,
  networkEpoch,
  getNetworkEpoch,
  signalingJoined,
  isSignalingReady,
  whenSignalingReady,
  setEpochTransferTeardown,
  endNetworkEpoch,
  ownerFor,
} from './session-scope'
import { initNetwork, destroyNetwork } from './signaling-controller'
import { buildNetworkActions } from './network-actions'
export { pruneChatMessages } from './runtime-helpers'

export type { NetworkState, SignalingStatus, NetworkStatusKey, EpochTransferTeardown, ResumeFailureCode }
export { PartialFanoutError, TransferResumeError }
export {
  outgoingQueue,
  queuedMessageIds,
  seenInboundChatIds,
}
export type { FlushResult } from './contracts'
export { getAutoTurnSnapshot } from './connectivity-controller'
export {
  setSendingFileForTests,
  getTransferDeliveryState,
  pruneTerminalTransferCards,
  checkResumePreconditions,
  sendingFiles,
  shortIdToTransferId,
  transferDelivery,
  transferSpeedSamples,
  deliveredTransfers,
  pendingDurableAcks,
}
export {
  getPendingSignalingQueueCount,
  getPendingRemoteIceCount,
  getPendingRemoteIceCandidateCount,
  getPendingRemoteIceReservationCount,
  getPendingRemoteIceOverflowState,
  type PendingRemoteIceOverflowState,
}
export {
  peerConnections,
  dataChannels,
  transferLanes,
}
export {
  getNetworkEpoch,
  setEpochTransferTeardown,
  networkEpoch,
  signalingJoined,
}

export const useNetworkStore = create<NetworkState>((set, get) => ({
  wsConnected: false,
  signalingStatus: 'idle',
  mySessionId: null,
  channelId: null,
  peers: [],
  selectedSessionId: null,
  transfers: [],
  chatMessages: {},
  pendingFiles: {},
  connectedPeers: new Set(),
  unreadByPeer: {},
  sendingPeers: new Set(),
  myNatType: getDetectedNatType(),
  autoTurnAvailable: true,

  init(token: string) {
    initNetwork(token)
  },

  destroy() {
    destroyNetwork()
  },

  ...buildNetworkActions(set, get),
}))

// Composition: domain modules reach state only via StorePort.
bindStorePort({
  getState: () => useNetworkStore.getState(),
  setState: (partial) => { useNetworkStore.setState(partial as never) },
})

bindDeps({
  ensureConnected,
  ensureTransferLanes,
  dataChannels,
  peerConnections,
  transferLanes,
  ownerFor,
  getNetworkEpoch: () => networkEpoch,
  networkEpochRef: () => networkEpoch,
  endNetworkEpoch,
  attemptIceRestart,
  cleanupPeerConnection,
  initiateWebRTC,
  abandonPeerConnection,
  installIceCandidateHandler,
  capturePeerConnectionAttempt,
  isPeerConnectionAttemptCurrent,
  beginLocalOffer,
  invalidatePendingLocalOffer,
  isLocalOfferCurrent,
  negState,
  sendLocalOffer,
  isPolite,
  captureSignalReceipt,
  enqueuePeerTask,
  handleRemoteSDP,
  handleRemoteICE,
  handleRemoteICEEnd,
  getPendingSignalingQueueCount,
  getPendingRemoteIceCount,
  getPendingRemoteIceCandidateCount,
  getPendingRemoteIceReservationCount,
  getPendingRemoteIceOverflowState,
  clearPeerNegotiationState,
  clearAllNegotiationState,
  invalidatePeerSignalingIncarnation,
  peerSignalingIncarnation,
  peerTaskQueues,
  peerSignalingIncarnations,
  peerLocalOfferTokens,
  pendingRemoteIce,
  configuredDataChannels,
  ecdhResolvers,
  initialEncryptedSessionRebuilds,
  clearInitialIceRecovery,
  handleIceStateChange,
  scheduleInitialIceRecovery,
  clearDisconnectedTimer,
  iceRestartRetryTimers,
  iceRestarting,
  iceRestartAttempts,
  setupDataChannel,
  notifyPrimaryChannel,
  whenSignalingReady,
  isSignalingReady,
  peerGeneration,
  bumpPeerGeneration,
  isCurrentGeneration,
  captureGenerationAttempt,
  isPeerGenerationAttemptCurrent,
  peerGenerations,
  initiatingPeers,
  connectingPeers,
  primaryChannelResolvers,
  recoverConnections,
  propagateIceConfig,
  renegotiateOrphanPeers,
  installForegroundRecovery,
  installTurnConfigPropagation,
  startNatAndTurnProbes,
  transferSpeedSamples,
  remoteInitiatingPeers,
  failPendingMessages,
  shortIdToTransferId,
  pendingIceMigration,
  get currentToken() { return currentToken },
} as any)
