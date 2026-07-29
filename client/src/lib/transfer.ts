/**
 * transfer.ts — PUBLIC FACADE (Wave 4a mechanical split).
 *
 * Re-exports the existing public API unchanged so network.ts and every
 * existing test keep importing exactly what they import today.
 * Implementation lives under ./transfer/* — no semantic change.
 *
 * Module map:
 *   transfer/protocol.ts        version, messages, meta validation, frame codec
 *   transfer/ownership.ts       (peerSessionId, epoch) owner + attempt token
 *   transfer/flow-control.ts    buffer wait, pause/cancel signals
 *   transfer/send-engine.ts     send task, repair, delivery state, ready barrier
 *   transfer/receive-engine.ts  session, persist order, finalize/abort
 *   transfer/storage/*          FSA / OPFS / IDB backends (each owns handles)
 *   transfer/registry.ts        single terminal teardown
 */

// ── protocol ─────────────────────────────────────────────────────────
export {
  CHUNK_SIZE,
  MAX_FILE_SIZE,
  validateAndNormalizeRanges,
  PROTOCOL_VERSION,
  AAD_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
  setPeerProtocolVersion,
  getPeerProtocolVersion,
  negotiatedProtocolVersion,
  clearPeerProtocolVersion,
  makeHelloMessage,
  MAX_TRANSFER_ID_LENGTH,
  MAX_FILE_NAME_LENGTH,
  MAX_MIME_LENGTH,
  MAX_TOTAL_CHUNKS,
  expectedChunkCount,
  expectedChunkLength,
  sanitizeFileName,
  validateMetaMessage,
  isValidChunkIndex,
  CHUNK_FRAME_TAG,
  CHUNK_FRAME_HEADER_BYTES,
  CHUNK_FRAME_IV_OFFSET,
  CHUNK_FRAME_IV_LENGTH,
  CHUNK_FRAME_CIPHER_OFFSET,
  encodeChunkFrame,
  decodeChunkFrame,
  type MetaMessage,
  type ReadyMessage,
  type RejectMessage,
  type RepairRequest,
  type DoneMessage,
  type ResumeRequest,
  type DCProtocolMessage,
  type MetaValidationFailure,
  type MetaValidationResult,
  type DecodedChunkFrame,
} from './transfer/protocol'

// ── ownership ────────────────────────────────────────────────────────
export {
  TransferOwnershipError,
  getTransferOwner,
  registerTransferOwner,
  clearTransferOwner,
  assertTransferOwner,
  type TransferOwner,
  type TransferAttempt,
  type OwnerRecord,
} from './transfer/ownership'

// ── flow-control ─────────────────────────────────────────────────────
export {
  WAIT_FOR_BUFFER_TIMEOUT_MS,
  BufferWaitTimeoutError,
  waitForBuffer,
  pauseTransfer,
  resumeTransfer,
  cancelTransfer,
  TransferCancelledError,
  clearTransferSignal,
} from './transfer/flow-control'

// ── send-engine ──────────────────────────────────────────────────────
export {
  type DeliveryState,
  type SendOutcome,
  type SendCallbacks,
  getSendTaskInfo,
  hasLiveSendTask,
  hasSendTask,
  markTransferAcked,
  applyRepairRequest,
  RECEIVER_ACK_TIMEOUT_MS,
  setLaneDrainTimeoutMsForTests,
  LaneDrainTimeoutError,
  neutralizeSendTask,
  isSendNeutralized,
  awaitSendEngineSettlement,
  sendFileParallel,
  RECEIVER_READY_TIMEOUT_MS,
  markReceiverReady,
  markReceiverRejected,
  clearReceiverReady,
  applyPeerPause,
  applyPeerResume,
  applyPeerCancel,
} from './transfer/send-engine'

// ── receive-engine ───────────────────────────────────────────────────
export {
  type ReceiveCallbacks,
  MAX_BUFFERED_PRECOMMIT_BYTES,
  getReceiveSession,
  type MetaRejection,
  checkBackendOOMGuard,
  checkMetaOOMGuard,
  handleMetaMessage,
  type PrepareBackendResult,
  prepareReceiveBackend,
  isReceiveBackendReady,
  type ReceiveFrameView,
  receiveChunk,
  buildRepairRequest,
  droppedWhilePausedCount,
  assembleFile,
  type FinalizeResult,
  TransferIntegrityError,
  finalizeReceive,
  takePendingCompletedResult,
  resumeTerminalCleanupIntents,
  abortInboundTransfer,
  completeReceive,
  cancelReceive,
  buildResumeRequest,
  decodeResumeRequest,
  humanizeError,
  createTransferId,
  checkForResumableTransfers,
} from './transfer/receive-engine'

// ── storage ──────────────────────────────────────────────────────────
export {
  type OPFSReceiveHandle,
  supportsOPFS,
  createOPFSReceiveFile,
  getOPFSHandle,
  opfsWrittenCount,
  writeChunkToOPFS,
  getOPFSFile,
  removeOPFSEntry,
  cleanupOPFS,
} from './transfer/storage/opfs'

export {
  type FileWriteHandle,
  supportsFileSystemAccess,
  requestWriteHandle,
  getWriteHandle,
  streamChunkToDisk,
  finalizeStreamedFile,
  cancelStreamWrite,
} from './transfer/storage/fsa'

export {
  type PrepareReceiveStorageResult,
  prepareReceiveStorage,
} from './transfer/storage/backend'

// ── registry ─────────────────────────────────────────────────────────
export {
  forgetTransfer,
  resetTransferModuleState,
} from './transfer/registry'
