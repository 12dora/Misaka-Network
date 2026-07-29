/**
 * transfer/registry.ts — single terminal teardown orchestrator.
 * Centrally releases owner, ready waiter, task, session and backend maps.
 *
 * Does NOT clear: attempt-keyed irrevocable send gates for still-running
 * engines, or localStorage terminal-cleanup intents (scoped; re-armed by
 * resumeTerminalCleanupIntents after epoch/token change).
 */
import { clearPeerProtocolVersion } from './protocol'
import { transferOwners, clearTransferOwner } from './ownership'
import { transferSignals, clearTransferSignal } from './flow-control'
import {
  sendTasks, neutralizedSends,
  receiverReadyFlags, receiverReadyWaiters, clearReceiverReady,
  accountAllLiveSendEnginesForTeardown,
} from './send-engine'
import {
  receiveSessions, backendPreparations,
  terminalCleanupJobs, clearTerminalCleanupJob,
  resumeTerminalCleanupIntents,
} from './receive-engine'

/**
 * Drop every piece of module state a transfer owns. Called from the store's
 * epoch teardown once per transfer, and by `resetTransferModuleState()` for a
 * whole-epoch wipe. Idempotent.
 *
 * Does NOT clear attempt-keyed irrevocable gates for a still-running engine —
 * those clear only when that attempt settles (send-engine ownership).
 */
export function forgetTransfer(transferId: string) {
  transferSignals.delete(transferId)
  transferOwners.delete(transferId)
  receiveSessions.delete(transferId)
  sendTasks.delete(transferId)
  neutralizedSends.delete(transferId)
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
 * Attempt-keyed send gates for still-running detached engines stay until those
 * attempts settle. Durable terminal-cleanup intents survive and are re-armed.
 *
 * Order matters: hard-gate and detach every live/parked/unlisted engine FIRST
 * so wiping soft cancel signals cannot resurrect wire transmission for a
 * card-removed engine that was never in `state.transfers`.
 */
export function resetTransferModuleState() {
  // 1. Hard-gate + account every live engine (including parked unlisted).
  //    Irrevocable gates and detachedSendEngines survive the wipe below.
  accountAllLiveSendEnginesForTeardown()

  for (const job of terminalCleanupJobs.values()) {
    if (job.timer) clearTimeout(job.timer)
  }
  terminalCleanupJobs.clear()
  transferSignals.clear()
  transferOwners.clear()
  receiveSessions.clear()
  // sendTasks already emptied by detach; clear for safety.
  sendTasks.clear()
  neutralizedSends.clear()
  receiverReadyFlags.clear()
  for (const settle of receiverReadyWaiters.values()) settle(false)
  receiverReadyWaiters.clear()
  backendPreparations.clear()
  clearPeerProtocolVersion()
  // Same-tab epoch/token change cancelled in-memory timers above; re-arm from
  // durable scoped intents so cleanup work is not lost until the next full init.
  try { resumeTerminalCleanupIntents() } catch { /* ignore */ }
}

// Re-export clearTransferSignal for facade completeness
export { clearTransferSignal, clearTransferOwner }
