/**
 * Late-bound StorePort. Bound once by store.ts after the Zustand singleton is
 * created. Every domain module below store.ts reads/writes network state only
 * through this port — never by importing useNetworkStore.
 *
 * Cycle broken: setupDataChannel → chat/transfer → ensureConnected →
 * setupDataChannel (all used to close over the singleton).
 */

import type { StorePort } from './ports'

let port: StorePort | null = null

export function bindStorePort(p: StorePort): void {
  port = p
}

export function storeGet(): ReturnType<StorePort['getState']> {
  if (!port) throw new Error('[net] StorePort not bound — composition root must call bindStorePort')
  return port.getState()
}

export function storeSet(
  partial: Parameters<StorePort['setState']>[0],
): void {
  if (!port) throw new Error('[net] StorePort not bound — composition root must call bindStorePort')
  port.setState(partial)
}
