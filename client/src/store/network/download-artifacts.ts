/**
 * Single URL / OPFS download-artifact registry.
 *
 * Cleanup owner: download-artifacts module. Entries are retired by chat
 * prune, peer block, and session-scope epoch teardown via retire/release APIs.
 * Started downloads are NOT auto-revoked (browser has no completion signal).
 *
 * Module state:
 *   artifactLifecycleByUrl → releaseDownloadArtifact / retireDownloadArtifact
 *   ORPHANED_DOWNLOADS_CHAT_KEY chat rows → releaseDownloadArtifact (prunes
 *     released URL) / blockPeer (rehomes) / endNetworkEpoch (store clear)
 */
import { storeGet, storeSet } from './store-access'

interface DownloadArtifactLifecycle {
  cleanup?: () => Promise<void>
  started: boolean
}

/** Cleanup owner: download-artifacts (epoch teardown / blockPeer rehome). */
const artifactLifecycleByUrl = new Map<string, DownloadArtifactLifecycle>()

/** Chat messages with a started download rehomed after blockPeer (release path). */
export const ORPHANED_DOWNLOADS_CHAT_KEY = '__orphaned-downloads__'

export function registerDownloadArtifact(
  url: string,
  lifecycle: { cleanup?: () => Promise<void> },
): void {
  artifactLifecycleByUrl.set(url, { cleanup: lifecycle.cleanup, started: false })
}

export function markDownloadArtifactStarted(url: string): void {
  const lifecycle = artifactLifecycleByUrl.get(url)
  if (lifecycle) lifecycle.started = true
}

export function isDownloadArtifactStarted(url: string): boolean {
  return artifactLifecycleByUrl.get(url)?.started === true
}

/** Drop orphan-panel chat rows that pointed at a released URL. */
function pruneOrphanChatForUrl(url: string): void {
  try {
    const state = storeGet()
    const orphaned = state.chatMessages[ORPHANED_DOWNLOADS_CHAT_KEY]
    if (!orphaned?.length) return
    const next = orphaned.filter(m => m.downloadUrl !== url)
    if (next.length === orphaned.length) return
    const chatMessages = { ...state.chatMessages }
    if (next.length === 0) delete chatMessages[ORPHANED_DOWNLOADS_CHAT_KEY]
    else chatMessages[ORPHANED_DOWNLOADS_CHAT_KEY] = next
    storeSet({ chatMessages })
  } catch { /* store not bound in pure unit tests */ }
}

/** Explicit acknowledgement that the browser has finished saving the file. */
export async function releaseDownloadArtifact(url: string): Promise<void> {
  try { URL.revokeObjectURL(url) } catch { /* ignore */ }
  const lifecycle = artifactLifecycleByUrl.get(url)
  artifactLifecycleByUrl.delete(url)
  pruneOrphanChatForUrl(url)
  await lifecycle?.cleanup?.()
}

/**
 * Automatic UI retirement may clean an artefact only if no download started.
 * Once clicked, browsers expose no completion signal; deleting a lazy OPFS
 * entry at that point can cancel a legitimate slow download.
 */
export function retireDownloadArtifact(url: string): void {
  const lifecycle = artifactLifecycleByUrl.get(url)
  if (lifecycle?.started) return
  void releaseDownloadArtifact(url)
}

export function retireDownloadUrls(urls: string[]): void {
  for (const url of urls) retireDownloadArtifact(url)
}

/** Started downloads rehomed under ORPHANED_DOWNLOADS_CHAT_KEY by blockPeer; UI releases via releaseDownloadArtifact. */
