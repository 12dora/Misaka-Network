/**
 * Stable user-facing error codes → action-oriented zh-CN messages.
 * Stores keep `code` (+ optional `detail` for diagnostics); the UI never
 * paints raw HTTP status strings or Worker stack traces into primary chrome.
 */

import { transfer } from './zh-CN/transfer'

export type UserFacingErrorCode =
  | 'storage-full'
  | 'connection-lost'
  | 'encryption-failed'
  | 'rate-limited'
  | 'session-expired'
  | 'generic-failure'

export interface UserFacingErrorContext {
  fileName?: string
  detail?: string
}

const MESSAGES: Record<UserFacingErrorCode, (ctx?: UserFacingErrorContext) => string> = {
  'storage-full': (ctx) => transfer.storageFull({ fileName: ctx?.fileName }),
  'connection-lost': () => transfer.connectionLost,
  'encryption-failed': () => transfer.encryptionFailed,
  'rate-limited': () => transfer.rateLimited,
  'session-expired': () => transfer.sessionExpired,
  'generic-failure': () => transfer.genericFailure,
}

export function toUserMessage(
  code: UserFacingErrorCode,
  context?: UserFacingErrorContext,
): string {
  return MESSAGES[code](context)
}

/** Best-effort mapping from a raw Error/string into a stable code. */
export function classifyError(error: Error | string): UserFacingErrorCode {
  const msg = typeof error === 'string' ? error : error.message
  const lower = msg.toLowerCase()
  if (
    lower.includes('storage_quota') ||
    lower.includes('quotaexceeded') ||
    lower.includes('storage full') ||
    lower.includes('not enough space')
  ) {
    return 'storage-full'
  }
  if (
    lower.includes('429') ||
    lower.includes('rate limit') ||
    lower.includes('too many')
  ) {
    return 'rate-limited'
  }
  if (
    lower.includes('session') && (lower.includes('expir') || lower.includes('失效'))
  ) {
    return 'session-expired'
  }
  if (
    lower.includes('crypto') ||
    lower.includes('encrypt') ||
    lower.includes('decrypt') ||
    lower.includes('aes-gcm')
  ) {
    return 'encryption-failed'
  }
  if (
    lower.includes('disconnect') ||
    lower.includes('connection') ||
    lower.includes('network') ||
    lower.includes('offline')
  ) {
    return 'connection-lost'
  }
  return 'generic-failure'
}

export function toUserMessageFromUnknown(
  error: Error | string,
  context?: UserFacingErrorContext,
): string {
  return toUserMessage(classifyError(error), context)
}
