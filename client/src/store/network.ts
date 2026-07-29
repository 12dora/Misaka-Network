/**
 * network.ts — PUBLIC FACADE (Wave 4d finish).
 *
 * Re-exports the existing public API unchanged so pages, components and every
 * existing test keep importing exactly what they import today.
 * Implementation lives under ./network/* — no semantic change.
 *
 * Module map (lines, approximate):
 *   network/contracts.ts                   137  state slices, errors, result types
 *   network/selectors.ts                   128  deriveNetworkStatus, prune (pure)
 *   network/download-artifacts.ts            59  URL/OPFS artifact registry
 *   network/ports.ts                       256  StorePort + cycle-breaking ports
 *   network/store-access.ts                  28  late-bound StorePort
 *   network/deps.ts                        162  inter-controller deps bag
 *   network/session-scope.ts               239  epoch, token, readiness, teardown
 *   network/peer-runtime.ts                433  PC/DC/lanes, ensureConnected, cleanup
 *   network/negotiation-controller.ts     1190  SignalReceipt, pending ICE, glare
 *   network/ice-recovery.ts                572  restart/watchdog ownership
 *   network/connectivity-controller.ts     300  TURN/NAT surface
 *   network/data-channel-router.ts         389  label whitelist ownership
 *   network/chat-controller.ts             288  outgoing queue ownership
 *   network/transfer-controller.ts         679  demux/delivery surface
 *   network/signaling-controller.ts        374  init/destroy, WELCOME/roster
 *   network/network-actions.ts             446  Zustand action surface
 *   network/runtime-helpers.ts              12  pruneChatMessages
 *   network/runtime.ts                     275  composition: create + ports + deps
 *   network/store.ts                        57  composition re-exports (barrel)
 *
 * Cycle break: no module below store composition imports useNetworkStore.
 * Controllers use store-access (StorePort) and deps (injected ports).
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
} from './network/store'

export {
  PartialFanoutError,
  TransferResumeError,
  type NetworkState,
  type SignalingStatus,
  type NetworkStatusKey,
  type ResumeFailureCode,
} from './network/contracts'

export {
  deriveNetworkStatus,
  peerDisplayStatus,
  networkStatusLabel,
  isLikelyUnreachable,
} from './network/selectors'

export {
  ORPHANED_DOWNLOADS_CHAT_KEY,
  markDownloadArtifactStarted,
  isDownloadArtifactStarted,
  releaseDownloadArtifact,
} from './network/download-artifacts'
