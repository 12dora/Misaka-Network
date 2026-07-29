/**
 * Composition barrel for the network store (Wave 4d finish).
 *
 * The Zustand singleton is created in runtime.ts (StorePort + deps bound there).
 * Domain modules under this folder own their maps and controllers. Public API
 * is re-exported unchanged via ../network.ts.
 *
 * Domain modules:
 *   contracts, selectors, download-artifacts, ports, store-access,
 *   session-scope, peer-runtime, negotiation-controller, ice-recovery,
 *   connectivity-controller, data-channel-router, chat-controller,
 *   transfer-controller, signaling-controller, network-actions, runtime
 */

export {
  useNetworkStore,
  getNetworkEpoch,
  setEpochTransferTeardown,
  setSendingFileForTests,
  getTransferDeliveryState,
  getPendingSignalingQueueCount,
  getPendingRemoteIceCount,
  getPendingRemoteIceCandidateCount,
  getPendingRemoteIceReservationCount,
  getPendingRemoteIceOverflowState,
  getAutoTurnSnapshot,
  pruneTerminalTransferCards,
  pruneChatMessages,
  checkResumePreconditions,
  type FlushResult,
  type PendingRemoteIceOverflowState,
  type EpochTransferTeardown,
} from './runtime'

export {
  PartialFanoutError,
  TransferResumeError,
  type NetworkState,
  type SignalingStatus,
  type NetworkStatusKey,
  type ResumeFailureCode,
} from './contracts'

export {
  deriveNetworkStatus,
  peerDisplayStatus,
  networkStatusLabel,
  isLikelyUnreachable,
} from './selectors'

export {
  ORPHANED_DOWNLOADS_CHAT_KEY,
  markDownloadArtifactStarted,
  releaseDownloadArtifact,
} from './download-artifacts'
