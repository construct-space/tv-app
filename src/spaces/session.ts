/**
 * TV session: the device-login token + bound Construct identity.
 *
 * The token here is the bearer presented to graph.construct.space and
 * my.construct.space/api/source on the user's behalf, so spaces read the
 * real account's data. It is set once the desktop links the TV (see the Go
 * backend /api/device/poll, which returns { token, user }).
 */
export interface Identity {
  user_id?: string
  email?: string
  name?: string
  scope?: string
  org_id?: string
}

const TOKEN_KEY = 'constructtv_token'
const IDENTITY_KEY = 'constructtv_identity'
const REFRESH_KEY = 'constructtv_refresh'

let _token: string | null = localStorage.getItem(TOKEN_KEY)
let _refresh: string | null = localStorage.getItem(REFRESH_KEY)
let _identity: Identity | null = (() => {
  try { return JSON.parse(localStorage.getItem(IDENTITY_KEY) || 'null') } catch { return null }
})()

export function getToken(): string | null { return _token }
export function getIdentity(): Identity | null { return _identity }
export function getRefresh(): string | null { return _refresh }

export function setSession(token: string, identity: Identity | null): void {
  _token = token
  localStorage.setItem(TOKEN_KEY, token)
  if (identity) { _identity = identity; localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity)) }
}

export function setRefresh(refresh: string): void {
  _refresh = refresh
  localStorage.setItem(REFRESH_KEY, refresh)
}

export function clearSession(): void {
  _token = null
  _refresh = null
  _identity = null
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(IDENTITY_KEY)
  localStorage.removeItem(REFRESH_KEY)
}
