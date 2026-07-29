// Authed fetch helper.
//
// Server-side sessions live in memory (see server/src/store.ts) and the
// client persists tokens in sessionStorage purely by expiry. When the
// server restarts, the client still thinks it has a valid session — every
// subsequent `/api/*` call comes back with 401. This wrapper detects that
// case, re-registers using the cached identity, and retries once with the
// fresh token, so flows like QR fetch and copy-link recover transparently.
//
// On the second 401 (re-register also failed) we clear the cached session
// so the UI surfaces the login screen rather than spinning forever.

import { apiUrl } from '@/config'
import { useAuthStore } from '@/store/auth'

export class AuthRequiredError extends Error {
  constructor() { super('AUTH_REQUIRED') }
}

function currentToken(): string | null {
  return useAuthStore.getState().session?.token ?? null
}

async function reAuth(): Promise<string | null> {
  const { connect } = useAuthStore.getState()
  await connect()
  return useAuthStore.getState().session?.token ?? null
}

function withAuthHeader(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${token}`)
  return { ...init, headers }
}

function terminalAuthFailure(): never {
  // Single cleanup entry point — must release the node Web Lock, not only
  // clear sessionStorage / Zustand. Hard contract: still throw AuthRequiredError.
  useAuthStore.getState().invalidateSession()
  throw new AuthRequiredError()
}

// Fetch `path` (relative — prefixed via apiUrl) with the current Bearer
// token. On 401 we retry once with a freshly re-registered session.
// Throws AuthRequiredError if even re-auth comes back unauthorized so the
// caller can prompt the user, rather than displaying a raw "HTTP 401".
export async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  let token = currentToken()
  if (!token) {
    token = await reAuth()
    if (!token) terminalAuthFailure()
  }

  const url = apiUrl(path)
  let res = await fetch(url, withAuthHeader(init, token))
  if (res.status !== 401) return res

  const fresh = await reAuth()
  if (!fresh) terminalAuthFailure()
  res = await fetch(url, withAuthHeader(init, fresh))
  if (res.status === 401) terminalAuthFailure()
  return res
}
