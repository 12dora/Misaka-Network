/**
 * transfer/registry.ts — single terminal teardown orchestrator.
 * Centrally releases owner, ready waiter, task, session and backend maps.
 *
 * Does NOT clear: irrevocableSendGates, pendingCompletedResults, localStorage
 * terminal-cleanup intents (open ownership items — intentional survival).
 */
import { clearPeerProtocolVersion } from './protocol'
import { transferOwners, clearTransferOwner } from './ownership'
import { transferSignals, clearTransferSignal } from './flow-control'
import {
  sendTasks, neutralizedSends,
  receiverReadyFlags, receiverReadyWaiters, clearReceiverReady,
} from './send-engine'
import {
  receiveSessions, backendPreparations,
  terminalCleanupJobs, clearTerminalCleanupJob,
} from './receive-engine'

/**
 * Drop every piece of module state a transfer owns. Called from the store's
 * epoch teardown once per transfer, and by `resetTransferModuleState()` for a
 * whole-epoch wipe. Idempotent.
 */
export function forgetTransfer(transferId: string) {
  transferSignals.delete(transferId)
  transferOwners.delete(transferId)
  receiveSessions.delete(transferId)
  sendTasks.delete(transferId)
  neutralizedSends.delete(transferId)
  // Do NOT clear irrevocableSendGates here — epoch teardown calls forget while
  // an engine may still be mid-slice; the gate must outlive registry reset.
  clearReceiverReady(transferId)
  for (const key of [...backendPreparations.keys()]) {
    // preparationKey() joins with a NUL, which cannot occur in a session id.
    if (key.endsWith(`\u0000${transferId}`)) backendPreparations.delete(key)
  }
  // In-memory cleanup timers are cancelled, but durable intent (localStorage)
  // survives so a tab close mid-retry does not erase the only cleanup job.
  clearTerminalCleanupJob(transferId)
}

/**
 * Whole-epoch teardown: every transfer belonged to the identity that just went
 * away, so nothing here may survive into the next epoch — including the
 * negotiated protocol versions, which were announced by peers of the old
 * session.
 *
 * Irrevocable send gates and durable terminal-cleanup intents intentionally
 * survive so a parked engine / pending completed write cannot resume on the
 * wire or lose cleanup after registry wipe.
 */
export function resetTransferModuleState() {
  for (const job of terminalCleanupJobs.values()) {
    if (job.timer) clearTimeout(job.timer)
  }
  terminalCleanupJobs.clear()
  transferSignals.clear()
  transferOwners.clear()
  receiveSessions.clear()
  sendTasks.clear()
  neutralizedSends.clear()
  // irrevocableSendGates intentionally retained
  // pendingCompletedResults retained so undelivered completed files survive
  receiverReadyFlags.clear()
  for (const settle of receiverReadyWaiters.values()) settle(false)
  receiverReadyWaiters.clear()
  backendPreparations.clear()
  clearPeerProtocolVersion()
}

// Re-export clearTransferSignal for facade completeness
export { clearTransferSignal, clearTransferOwner }
