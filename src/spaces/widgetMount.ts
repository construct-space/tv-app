/**
 * Mount a space widget into an isolated Shadow DOM — the TV port of the desktop
 * lib/widgetSandbox.ts. Widgets are small, glanceable Vue components a space
 * exports under `tvWidgets`/`widgets` (widgetId → sizeKey → Component). They get
 * their DATA the same way pages do (window.construct, already CORS-proxied); the
 * injected `widgetApi` only carries theme/space/instance metadata.
 */
import { createApp, defineComponent, h, type Component } from 'vue'

export interface WidgetApi {
  instanceId: string
  theme: { mode: 'dark' | 'light'; vars: Record<string, string> }
  space: { id: string; name: string; icon: string }
  scheduler?: { list: () => Promise<unknown[]> }
}

// The --app-* / --c-* tokens a widget's Tailwind classes resolve against.
const TOKEN_NAMES = [
  '--app-background', '--app-foreground', '--app-muted', '--app-accent', '--app-accent-fg',
  '--app-border', '--app-surface', '--app-card', '--app-input-bg',
  '--c-bg', '--c-fg', '--c-muted', '--c-accent', '--c-accent-fg', '--c-border', '--c-surface', '--c-card', '--c-input',
]

export function readThemeVars(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement)
  const vars: Record<string, string> = {}
  for (const name of TOKEN_NAMES) {
    const v = cs.getPropertyValue(name).trim()
    if (v) vars[name] = v
  }
  return vars
}

function themeStyle(vars: Record<string, string>): HTMLStyleElement {
  const rules = Object.entries(vars).map(([k, v]) => `${k}: ${v};`).join('\n  ')
  const sans = "'Rubik', ui-sans-serif, system-ui, -apple-system, sans-serif"
  const style = document.createElement('style')
  style.textContent = `:host{\n  --font-sans:${sans};\n  --default-font-family:var(--font-sans);\n  ${rules}\n  color:${vars['--app-foreground'] || vars['--c-fg'] || 'inherit'};\n  background:transparent;\n  font-family:${sans};\n}\n.widget-root{height:100%;width:100%;}\n*{box-sizing:border-box;}`
  return style
}

// Clone the host document's stylesheets so the widget's Tailwind utilities resolve.
function cloneDocStyles(shadow: ShadowRoot): void {
  for (const node of document.head.querySelectorAll('link[rel="stylesheet"], style')) {
    if (node instanceof HTMLLinkElement) {
      const link = document.createElement('link')
      link.rel = 'stylesheet'; link.href = node.href
      if (node.crossOrigin) link.crossOrigin = node.crossOrigin
      shadow.appendChild(link)
    } else if (node instanceof HTMLStyleElement) {
      const clone = document.createElement('style')
      clone.textContent = node.textContent || ''
      shadow.appendChild(clone)
    }
  }
}

function wrapper(component: Component): Component {
  return defineComponent({ name: 'TvWidgetWrapper', setup() { return () => h(component) } })
}

/** Mount `component` into a shadow root on `hostElement`. Returns a cleanup fn. */
export function mountWidget(
  hostElement: HTMLElement,
  component: Component,
  api: WidgetApi,
  spaceCss?: string,
): () => void {
  const shadow = hostElement.attachShadow({ mode: 'open' })
  cloneDocStyles(shadow)
  if (spaceCss?.trim()) {
    const s = document.createElement('style')
    s.textContent = spaceCss
    shadow.appendChild(s)
  }
  shadow.appendChild(themeStyle(api.theme.vars))
  const root = document.createElement('div')
  root.className = 'widget-root'
  shadow.appendChild(root)

  const app = createApp(wrapper(component))
  app.provide('widgetApi', api)
  app.config.warnHandler = () => {}
  app.config.errorHandler = (err) => { console.warn('[tv widget] error:', err) }
  app.mount(root)
  return () => { try { app.unmount() } catch { /* ignore */ } }
}
