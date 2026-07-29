/**
 * Single URL / OPFS download-artifact registry.
 *
 * Cleanup owner: download-artifacts module. Entries are retired by chat
 * prune, peer block, and session-scope epoch teardown via retire/release APIs.
 * Started downloads are NOT auto-revoked (browser has no completion signal).
 */

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

/** Explicit acknowledgement that the browser has finished saving the file. */
export async function releaseDownloadArtifact(url: string): Promise<void> {
  try { URL.revokeObjectURL(url) } catch { /* ignore */ }
  const lifecycle = artifactLifecycleByUrl.get(url)
  artifactLifecycleByUrl.delete(url)
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

/** Open ownership (do not fix here): started artifacts rehomed under ORPHANED_DOWNLOADS_CHAT_KEY. */
