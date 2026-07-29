/**
 * transfer/ownership.ts — (peerSessionId, epoch) owner and attempt token.
 * Cleanup owner: clearTransferOwner / registry.forgetTransfer / resetTransferModuleState.
 */
// ── Transfer ownership (SECURITY-015) ────────────────────────────────
// A transfer belongs to exactly one `(peerSessionId, epoch)` pair. `nodeId`
// is NOT an owner: every device of one identity shares it, so a third device
// in the same cluster could otherwise learn a transferId and then observe the
// resume bitmap or issue pause/cancel against a transfer between two other
// devices. Every control-plane entry point runs `assertTransferOwner` first.

export interface TransferOwner {
  peerSessionId: string
  epoch: number
}

export interface OwnerRecord extends TransferOwner {
  direction: 'send' | 'recv'
  /** Immutable metadata — a second `meta` claiming different geometry for the
   *  same id is an attack (or a bug) and must be refused, not merged. */
  fileName: string
  fileSize: number
  totalChunks: number
}

// Cleanup owner: clearTransferOwner / registry.forgetTransfer / resetTransferModuleState
export const transferOwners = new Map<string, OwnerRecord>()

export class TransferOwnershipError extends Error {
  code: 'owner-mismatch' | 'metadata-mismatch'
  constructor(code: 'owner-mismatch' | 'metadata-mismatch', message: string) {
    super(message)
    this.name = 'TransferOwnershipError'
    this.code = code
  }
}

export function getTransferOwner(transferId: string): TransferOwner | undefined {
  const rec = transferOwners.get(transferId)
  return rec ? { peerSessionId: rec.peerSessionId, epoch: rec.epoch } : undefined
}

export function registerTransferOwner(transferId: string, record: OwnerRecord) {
  transferOwners.set(transferId, record)
}

export function clearTransferOwner(transferId: string) {
  transferOwners.delete(transferId)
}

/**
 * True when `owner` may act on an EXISTING in-memory `transferId`.
 *
 * Unknown transferIds return FALSE — peer-driven control handlers must not
 * create state for an id the local side has never registered.
 *
 * IMPORTANT: do **not** use this for durable-row resume after reload/reset.
 * `transferOwners` is emptied by epoch teardown and page reload; a matching
 * persisted `TransferRecord` is still resumable via durable field checks in
 * `buildResumeRequest` / `matchesDurableReceiveOwner`. Registration is a
 * separate API (`registerTransferOwner` / `handleMetaMessage` / `sendFileParallel`).
 */
export function assertTransferOwner(transferId: string, owner: TransferOwner | undefined): boolean {
  const rec = transferOwners.get(transferId)
  if (!rec) return false
  if (!owner) return false
  return rec.peerSessionId === owner.peerSessionId && rec.epoch === owner.epoch
}

/**
 * Durable-row ownership for resume paths. Does not consult the in-memory
 * owner map — after reload that map is empty while the IDB row remains.
 * Records without peerSessionId (pre-v2) stay resumable under any owner.
 */
export function matchesDurableReceiveOwner(
  record: { peerSessionId?: string; epoch?: number },
  owner: TransferOwner | undefined,
): boolean {
  if (!owner) return true
  if (record.peerSessionId && record.peerSessionId !== owner.peerSessionId) return false
  if (record.epoch !== undefined && record.epoch !== owner.epoch) return false
  return true
}

/** An attempt is identified by all four fields, never by transferId alone. */
export interface TransferAttempt {
  transferId: string
  shortId: number
  peerSessionId: string
  epoch: number
}

