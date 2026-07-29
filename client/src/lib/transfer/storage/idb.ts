/**
 * transfer/storage/idb.ts — IndexedDB chunk-store backend.
 * Handles: none local (rows live in db.ts). Cleanup owner: deleteChunks via
 * finalizeReceive / abortInboundTransfer / registry residual drop.
 *
 * prepare: no-op (db always available)
 * write:   saveChunk(transferId, index, data) from ../../db
 * finalize: assembleFile in receive-engine (needs session mime/name)
 * abort:   deleteChunks(transferId)
 *
 * The IDB path has no module-global handle map — that is intentional.
 */
export const IDB_BACKEND = 'idb' as const
