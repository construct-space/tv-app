/**
 * TV Space Host — the light-client analogue of construct-app/frontend/lib/spaceHost.ts.
 *
 * Space IIFE bundles are built with rollup externals: `import { ref } from 'vue'`
 * resolves at runtime to `window.__CONSTRUCT__['vue'].ref`, and data/auth flows
 * read `window.construct.*`. We expose exactly those two globals so an unmodified
 * marketplace `.space` bundle (e.g. mail) runs on the TV.
 *
 * Two deliberate differences from the desktop host:
 *  1. The SDK surface is a *graceful* Proxy. The desktop ships ~60 host
 *     composables; the TV implements the ones that matter (toast, brain, org,
 *     navigation) and returns a safe no-op composable for anything else, so a
 *     space that calls an unimplemented desktop-only helper renders instead of
 *     crashing.
 *  2. There is no Tauri. `shell.openUrl` → window.open, storage → localStorage.
 */
import * as Vue from 'vue'
import { ref, reactive, computed } from 'vue'
import * as VueRouter from 'vue-router'
import * as Pinia from 'pinia'
import * as VueUseCore from '@vueuse/core'
import * as Lucide from 'lucide-vue-next'
import * as DateFns from 'date-fns'
import DexieDefault, * as DexieNs from 'dexie'
import * as Zod from 'zod'
import * as ConstructUI from '@construct-space/ui'
import * as ConstructSdk from '@construct-space/sdk'
import { getIdentity, getToken } from './session'

const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env

// Same-origin endpoints: the TV's Go backend proxies these to the real Construct
// services so space bundles dodge browser CORS (the desktop avoids CORS via Tauri).
// graphUrl is "<origin>/api" so a space building `${graphUrl}/graphql` hits the proxy.
const ORIGIN = typeof location !== 'undefined' ? location.origin : ''
export const TV_CONFIG = {
  graphUrl: env.VITE_GRAPH_URL || `${ORIGIN}/api`,
  apiBase: env.VITE_API_BASE || `${ORIGIN}/api/source`,
  gatewayUrl: env.VITE_GATEWAY_URL || ORIGIN,
}

declare global {
  interface Window {
    __CONSTRUCT__?: Record<string, unknown>
    construct?: Record<string, unknown>
    [key: `__CONSTRUCT_SPACE_${string}`]: unknown
  }
}

/** A toast bus the TV shell can subscribe to (so spaces' toasts show on screen). */
type ToastKind = 'success' | 'error' | 'info' | 'warning'
export interface ToastEvent { id: number; kind: ToastKind; message: string }
const toastListeners = new Set<(t: ToastEvent) => void>()
let toastSeq = 0
export function onToast(fn: (t: ToastEvent) => void): () => void {
  toastListeners.add(fn)
  return () => toastListeners.delete(fn)
}
function emitToast(kind: ToastKind, message: string) {
  const ev = { id: ++toastSeq, kind, message }
  toastListeners.forEach(l => { try { l(ev) } catch { /* ignore */ } })
}

/** Generic no-op composable for desktop-only host helpers a space may import. */
function noopComposable(): unknown {
  return new Proxy(function () { return undefined } as unknown as Record<string, unknown>, {
    get(_t, key) {
      if (key === 'value') return undefined
      // ref-like and method-like access both resolve to harmless stubs
      return () => undefined
    },
    apply() { return undefined },
  })
}

/** Real-ish TV implementations of the host composables spaces actually call. */
function tvSdkOverlay(): Record<string, unknown> {
  return {
    useToast: () => ({
      success: (m: string) => emitToast('success', m),
      error: (m: string) => emitToast('error', m),
      info: (m: string) => emitToast('info', m),
      warning: (m: string) => emitToast('warning', m),
      show: (m: string) => emitToast('info', m),
      message: (m: string) => emitToast('info', m),
    }),
    useNotification: () => ({
      notify: (m: string | { message?: string; title?: string }) =>
        emitToast('info', typeof m === 'string' ? m : (m.message || m.title || '')),
    }),
    // The TV has no chrome these target — return inert reactive stubs.
    useToolbar: () => ({ setActions: () => {}, clear: () => {}, actions: ref([]) }),
    useSidebar: () => ({ collapsed: ref(true), toggle: () => {}, open: () => {}, close: () => {} }),
    useBreadcrumb: () => ({ set: () => {}, items: ref([]), push: () => {}, clear: () => {} }),
    useNavigator: () => ({
      push: (to: unknown) => { console.debug('[tv] navigator.push', to) },
      replace: () => {},
      back: () => {},
      go: () => {},
    }),
    useOrg: () => {
      const id = getIdentity()
      const isOrg = !!id?.org_id
      return { isOrg: computed(() => isOrg), orgId: computed(() => id?.org_id || null), org: ref(id?.org_id ? { id: id.org_id } : null) }
    },
    useOrgRoles: () => ({ roles: ref([]), can: () => true, hasRole: () => false }),
    useScheduler: () => ({ schedule: () => {}, cancel: () => {}, every: () => {} }),
    useStorage: () => (window.construct as { storage: unknown }).storage,
    useBrain: () => null, // spaces are told to guard `if (!brain) return`
  }
}

/** Build the graceful SDK Proxy: npm exports + TV overlay + no-op fallback. */
function buildSdkProxy(): Record<string, unknown> {
  const base: Record<string, unknown> = { ...(ConstructSdk as Record<string, unknown>), ...tvSdkOverlay() }
  return new Proxy(base, {
    get(target, key) {
      if (typeof key === 'symbol') return Reflect.get(target, key)
      if (key in target) return target[key]
      // Unknown `useXxx` → graceful no-op composable so the space keeps rendering.
      if (typeof key === 'string' && /^use[A-Z]/.test(key)) {
        console.warn(`[tv host] space used unimplemented SDK composable "${key}" — returning no-op`)
        return () => noopComposable()
      }
      return undefined
    },
    has() { return true },
  })
}

let initialized = false
export function initSpaceHost(): void {
  if (initialized && window.__CONSTRUCT__) return
  initialized = true

  window.__CONSTRUCT__ = {
    vue: Vue,
    'vue-router': VueRouter,
    pinia: Pinia,
    '@vueuse/core': VueUseCore,
    // NOTE: @vueuse/integrations is intentionally omitted — it eagerly pulls
    // ~12 optional peers (focus-trap, jwt-decode, qrcode, …) that bloat the TV
    // bundle. Mail and the home spaces don't use it; add it back with its peers
    // if a future space externalises it.
    'lucide-vue-next': Lucide,
    'date-fns': DateFns,
    dexie: Object.assign(DexieDefault, DexieNs),
    zod: Zod,
    '@construct-space/ui': ConstructUI,
    '@construct-space/sdk': buildSdkProxy(),
  }

  const storage = {
    async get(k: string) { return localStorage.getItem(`space:${k}`) },
    async set(k: string, v: string) { localStorage.setItem(`space:${k}`, v) },
    async remove(k: string) { localStorage.removeItem(`space:${k}`) },
  }

  window.construct = reactive({
    config: { graphUrl: TV_CONFIG.graphUrl, apiBase: TV_CONFIG.apiBase },
    auth: {
      async getAccessToken(): Promise<string | null> { return getToken() || null },
      getUserId(): string | null { return getIdentity()?.user_id || null },
    },
    space: { id: '' }, // re-pinned per space at load time
    project: { id: 'default' },
    get scope(): 'app' | 'org' { return getIdentity()?.org_id ? 'org' : 'app' },
    operator: {
      async send(type: string, _payload?: Record<string, unknown>) {
        // media.* / storage.* are the only space-facing operator calls; the TV
        // has no native bridge yet, so surface a clear, non-fatal signal.
        console.warn(`[tv host] operator.send("${type}") not available on TV`)
        return null
      },
    },
    storage,
    shell: { async openUrl(url: string) { window.open(url, '_blank', 'noopener,noreferrer') } },
    graph: {
      async query<T = unknown>(query: string, variables: Record<string, unknown> = {}, options?: { spaceId?: string; projectId?: string }): Promise<T> {
        const token = getToken()
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'X-Space-ID': options?.spaceId || (window.construct?.space as { id?: string })?.id || 'default',
          'X-Project-ID': options?.projectId || 'default',
        }
        if (token) headers.Authorization = `Bearer ${token}`
        const resp = await fetch(`${TV_CONFIG.graphUrl}/graphql`, {
          method: 'POST', headers, body: JSON.stringify({ query, variables }),
        })
        if (resp.status === 401) throw new Error('graph: not authenticated')
        if (!resp.ok) throw new Error(`Graph request failed (${resp.status})`)
        const json = await resp.json() as { data?: T; errors?: Array<{ message: string }> }
        if (json.errors?.length) throw new Error(`Graph errors: ${json.errors.map(e => e.message).join('; ')}`)
        return json.data as T
      },
    },
  }) as unknown as Record<string, unknown>
}

/** Re-pin the active space id on the runtime (graph reads it per request). */
export function setActiveSpace(spaceId: string): void {
  if (window.construct) (window.construct.space as { id: string }).id = spaceId
}
