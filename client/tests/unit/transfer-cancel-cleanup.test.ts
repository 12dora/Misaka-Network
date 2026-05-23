// Regression for the cancelReceive cleanup hole.
//
// Before the fix: cancelling a multi-GB inbound transfer left every
// already-received chunk row in IndexedDB indefinitely — a guaranteed quota
// blow-up across many cancellations. The cancel path *only* deleted the
// in-memory session, never `deleteChunks(transferId)`.

import { describe, it, expect, vi } from 'vitest'

// vi.mock factories are hoisted — can't close over top-level constants.
// Define the spies inside the factory and re-import them via the mocked
// module afterwards.
vi.mock('../../src/lib/db', () => ({
  saveTransfer: vi.fn(async () => {}),
  updateTransfer: vi.fn(async () => {}),
  getTransfer: vi.fn(async () => null),
  getActiveTransfers: vi.fn(async () => []),
  saveChunk: vi.fn(async () => {}),
  getChunk: vi.fn(async () => null),
  deleteChunks: vi.fn(async () => {}),
  getSavedChunkIndexes: vi.fn(async () => []),
}))

import { cancelReceive } from '../../src/lib/transfer'
import * as db from '../../src/lib/db'
const deleteChunksSpy = vi.mocked(db.deleteChunks)
const updateTransferSpy = vi.mocked(db.updateTransfer)

describe('cancelReceive: cleans up persisted chunks', () => {
  it('calls deleteChunks(transferId) so cancelled inbound transfers do not leak', () => {
    cancelReceive('abandoned-transfer-id')

    // The order is: receiveSessions.delete → deleteChunks → updateTransfer.
    // We only need to assert that deleteChunks was called with the right id.
    expect(deleteChunksSpy).toHaveBeenCalledWith('abandoned-transfer-id')
    // And the record is marked failed so the UI / resume logic doesn't try
    // to bring it back from the dead.
    expect(updateTransferSpy).toHaveBeenCalledWith('abandoned-transfer-id', { status: 'failed' })
  })
})
