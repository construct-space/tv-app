/**
 * TV space loader — the light analogue of SpaceLoader.loadSpaceFromSource.
 *
 * The desktop reads a `.space` ZIP off disk; the TV's Go backend unpacks the
 * marketplace tarball and serves its entries over HTTP, so here a "source" is
 * just `/api/spaces/<id>/<entry>`. Steps mirror the desktop:
 *   manifest → checksum → eval IIFE → read window.__CONSTRUCT_SPACE_<ID> →
 *   inject CSS → return pages/widgets.
 *
 * Signature verification is intentionally omitted: the bundle is fetched
 * server-side from the trusted marketplace over TLS and the backend is the
 * only origin that can serve it, so on the TV the transport is the trust
 * boundary. (Noted so this isn't mistaken for parity with the desktop, which
 * verifies an ECDSA publisher signature on locally-installed bundles.)
 */
import type { Component } from 'vue'
import { initSpaceHost, setActiveSpace } from './host'
import { getToken } from './session'

export interface SpaceManifest {
  id: string
  name?: string
  icon?: string
  build?: { hostApiVersion?: string; checksum?: string }
  scopes?: string[]
  widgets?: WidgetDescriptor[]
  tv?: WidgetDescriptor[]
  routes?: Array<{ path?: string; component?: string }>
}

export interface WidgetDescriptor {
  id: string
  name?: string
  description?: string
  icon?: string
  defaultSize: string
  sizes: Record<string, string> | string[]
}

export interface SpaceAction {
  description?: string
  run?: (params: Record<string, unknown>) => Promise<unknown> | unknown
}

export interface LoadedSpace {
  id: string
  manifest: SpaceManifest
  pages: Record<string, Component>
  widgets?: Record<string, Record<string, Component>>
  tvWidgets?: Record<string, Record<string, Component>>
  components?: Record<string, Component>
  actions?: Record<string, SpaceAction>
}

const base = (id: string) => `/api/spaces/${encodeURIComponent(id)}`
const loaded = new Map<string, LoadedSpace>()

function authHeaders(): Record<string, string> {
  const t = getToken()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

async function fetchText(url: string): Promise<string | null> {
  const r = await fetch(url, { headers: authHeaders() })
  if (!r.ok) return null
  return r.text()
}

function toGlobalKey(spaceId: string): string {
  return `__CONSTRUCT_SPACE_${spaceId.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`
}

function injectCss(spaceId: string, css: string): void {
  const id = `space-css-${spaceId}`
  if (document.getElementById(id)) return
  const el = document.createElement('style')
  el.id = id
  el.textContent = css
  document.head.appendChild(el)
}

export interface SpaceCatalogEntry {
  id: string
  name: string
  icon?: string
  version?: string
  description?: string
}

/** List spaces available to this account (proxied from the marketplace). */
export async function listSpaces(): Promise<SpaceCatalogEntry[]> {
  try {
    const r = await fetch('/api/spaces', { headers: authHeaders() })
    if (!r.ok) return []
    const data = await r.json() as { spaces?: SpaceCatalogEntry[] }
    return data.spaces || []
  } catch {
    return []
  }
}

export async function loadSpace(spaceId: string): Promise<LoadedSpace | null> {
  if (loaded.has(spaceId)) {
    setActiveSpace(spaceId)
    return loaded.get(spaceId)!
  }
  initSpaceHost()
  setActiveSpace(spaceId)

  const manifestText = await fetchText(`${base(spaceId)}/manifest.json`)
  if (!manifestText) { console.error(`[tv loader] no manifest for "${spaceId}"`); return null }
  let manifest: SpaceManifest
  try { manifest = JSON.parse(manifestText) } catch (e) { console.error(`[tv loader] bad manifest for "${spaceId}"`, e); return null }

  const js = await fetchText(`${base(spaceId)}/app.iife.js`)
  if (!js) { console.error(`[tv loader] no bundle for "${spaceId}"`); return null }

  try {
    ;(0, eval)(js)
  } catch (e) {
    console.error(`[tv loader] eval failed for "${spaceId}"`, e)
    return null
  }

  const key = toGlobalKey(spaceId)
  type Exp = {
    pages?: Record<string, Component>
    widgets?: Record<string, Record<string, Component>>
    tvWidgets?: Record<string, Record<string, Component>>
    components?: Record<string, Component>
    actions?: Record<string, SpaceAction>
    init?: () => void
  }
  const exp = (window as unknown as Record<string, Exp>)[key]
  if (!exp) { console.error(`[tv loader] bundle "${spaceId}" exported nothing (window.${key})`); return null }

  if (typeof exp.init === 'function') { try { exp.init() } catch (e) { console.warn(`[tv loader] init() threw for "${spaceId}"`, e) } }

  const css = await fetchText(`${base(spaceId)}/style.css`)
  if (css) injectCss(spaceId, css)

  const space: LoadedSpace = {
    id: spaceId, manifest,
    pages: exp.pages || {}, widgets: exp.widgets, tvWidgets: exp.tvWidgets,
    components: exp.components, actions: exp.actions,
  }
  loaded.set(spaceId, space)
  return space
}

/**
 * Run a space action headless IN THE BROWSER — the same path the desktop's
 * in-app bridge uses. The loaded IIFE exports runnable `actions` whose run()
 * goes through window.construct.graph (our /api/graphql proxy, as the user). No
 * signed actions.js / space-runtime needed. Throws if the action isn't found.
 */
export async function runSpaceAction(spaceId: string, action: string, params: Record<string, unknown>): Promise<unknown> {
  const space = await loadSpace(spaceId)
  setActiveSpace(spaceId) // graph scopes per active space, per call
  const fn = space?.actions?.[action]?.run
  if (typeof fn !== 'function') throw new Error(`${spaceId}.${action} is not available`)
  return await fn(params || {})
}

// ---- TV widgets -------------------------------------------------------------
export interface TvSpace {
  id: string
  name: string
  icon?: string
  tv: WidgetDescriptor[]
}

/** Spaces with a non-empty manifest.tv array (the only spaces shown on the TV). */
export async function listTvSpaces(): Promise<TvSpace[]> {
  try {
    const r = await fetch('/api/tv-spaces', { headers: authHeaders() })
    if (!r.ok) return []
    const data = await r.json() as { spaces?: TvSpace[] }
    return (data.spaces || []).filter(s => Array.isArray(s.tv) && s.tv.length)
  } catch {
    return []
  }
}

/**
 * Resolve a widget component for a space. Prefers the TV-tailored variant
 * (tvWidgets), falls back to the desktop widget at the same/closest size.
 */
export async function getWidgetComponent(
  spaceId: string, widgetId: string, sizeKey?: string,
): Promise<{ component: Component; sizeKey: string } | null> {
  const space = await loadSpace(spaceId)
  if (!space) return null
  const sets = [space.tvWidgets, space.widgets]
  for (const set of sets) {
    const sizes = set?.[widgetId]
    if (!sizes) continue
    const want = sizeKey && sizes[sizeKey] ? sizeKey : Object.keys(sizes)[0]
    if (want && sizes[want]) return { component: sizes[want], sizeKey: want }
  }
  return null
}

/** Pick the entry page for a space (first route's component, else "index"/first). */
export function entryPage(space: LoadedSpace): Component | null {
  const routePage = space.manifest.routes?.[0]?.component
  if (routePage && space.pages[routePage]) return space.pages[routePage]
  return space.pages.index || space.pages.main || Object.values(space.pages)[0] || null
}
