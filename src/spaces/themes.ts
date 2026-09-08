// Construct themes for the TV — ported from construct-app useAppTheme.ts.
// Each theme supplies 5 base colors; border/surface/input are derived with the
// same lighten/darken heuristics as the desktop. applyTheme sets the --c-* and
// --app-* CSS variables so both the TV chrome and space widgets re-skin.

export interface Theme {
  id: string
  name: string
  mode: 'light' | 'dark'
  colors: { background: string; foreground: string; muted: string; accent: string; accentForeground: string }
}

export const THEMES: Theme[] = [
  { id: 'vs-dark', name: 'Dark', mode: 'dark', colors: { background: '#0f172a', foreground: '#e2e8f0', muted: '#64748b', accent: '#E63946', accentForeground: '#ffffff' } },
  { id: 'construct', name: 'Construct', mode: 'dark', colors: { background: '#1e1e1e', foreground: '#d4d4d4', muted: '#6b7280', accent: '#FF2D55', accentForeground: '#ffffff' } },
  { id: 'vs', name: 'Light', mode: 'light', colors: { background: '#f1f5f9', foreground: '#0f172a', muted: '#64748b', accent: '#E63946', accentForeground: '#ffffff' } },
  { id: 'dracula', name: 'Dracula', mode: 'dark', colors: { background: '#282a36', foreground: '#f8f8f2', muted: '#6272a4', accent: '#bd93f9', accentForeground: '#000000' } },
  { id: 'one-dark', name: 'One Dark', mode: 'dark', colors: { background: '#282c34', foreground: '#abb2bf', muted: '#5c6370', accent: '#61afef', accentForeground: '#000000' } },
  { id: 'night-owl', name: 'Night Owl', mode: 'dark', colors: { background: '#011627', foreground: '#d6deeb', muted: '#637777', accent: '#82aaff', accentForeground: '#000000' } },
  { id: 'github-dark', name: 'GitHub Dark', mode: 'dark', colors: { background: '#0d1117', foreground: '#c9d1d9', muted: '#8b949e', accent: '#58a6ff', accentForeground: '#000000' } },
  { id: 'monokai', name: 'Monokai', mode: 'dark', colors: { background: '#272822', foreground: '#f8f8f2', muted: '#75715e', accent: '#f92672', accentForeground: '#ffffff' } },
  { id: 'nord', name: 'Nord', mode: 'dark', colors: { background: '#2e3440', foreground: '#d8dee9', muted: '#616e88', accent: '#88c0d0', accentForeground: '#000000' } },
  { id: 'cobalt2', name: 'Cobalt2', mode: 'dark', colors: { background: '#193549', foreground: '#ffffff', muted: '#0088ff', accent: '#ffc600', accentForeground: '#000000' } },
  { id: 'material', name: 'Material', mode: 'dark', colors: { background: '#263238', foreground: '#eeffff', muted: '#546e7a', accent: '#89ddff', accentForeground: '#000000' } },
  { id: 'tokyo-night', name: 'Tokyo Night', mode: 'dark', colors: { background: '#1a1b26', foreground: '#c0caf5', muted: '#565f89', accent: '#7aa2f7', accentForeground: '#ffffff' } },
  { id: 'synthwave', name: "Synthwave '84", mode: 'dark', colors: { background: '#262335', foreground: '#f8f8f2', muted: '#848bbd', accent: '#ff7edb', accentForeground: '#000000' } },
  { id: 'hc-black', name: 'High Contrast', mode: 'dark', colors: { background: '#000000', foreground: '#ffffff', muted: '#808080', accent: '#ffff00', accentForeground: '#000000' } },
]

function hexToRgb(hex: string) {
  let h = hex.replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join('')
  const n = parseInt(h, 16); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}
function toHex(r: number, g: number, b: number) {
  return '#' + [r, g, b].map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('')
}
function darken(hex: string, a: number) { const c = hexToRgb(hex); return toHex(c.r * (1 - a), c.g * (1 - a), c.b * (1 - a)) }
function lighten(hex: string, a: number) { const c = hexToRgb(hex); return toHex(c.r + (255 - c.r) * a, c.g + (255 - c.g) * a, c.b + (255 - c.b) * a) }

export function applyTheme(t: Theme) {
  const c = t.colors, bg = c.background, root = document.documentElement
  const d = t.mode === 'dark'
    ? { border: lighten(bg, 0.15), surface: lighten(bg, 0.08), input: lighten(bg, 0.05), canvas: darken(bg, 0.3) }
    : { border: darken(bg, 0.1), surface: darken(bg, 0.02), input: darken(bg, 0.04), canvas: darken(bg, 0.05) }
  const set = (k: string, v: string) => root.style.setProperty(k, v)
  // The PAGE is the darker canvas; cards/widgets use the (lighter) background so
  // @construct-space/ui Card (which fills with --app-background) stands out — the
  // same layering the desktop uses. --c-* drive the TV chrome, --app-* the widgets.
  const map: Record<string, string> = {
    '--c-bg': d.canvas, '--c-fg': c.foreground, '--c-muted': c.muted, '--c-accent': c.accent, '--c-accent-fg': c.accentForeground,
    '--c-border': d.border, '--c-surface': d.surface, '--c-card': bg, '--c-input': d.input,
    '--app-background': bg, '--app-foreground': c.foreground, '--app-muted': c.muted, '--app-accent': c.accent,
    '--app-accent-fg': c.accentForeground, '--app-accent-foreground': c.accentForeground,
    '--app-border': d.border, '--app-surface': d.surface, '--app-card': bg, '--app-card-bg': bg,
    '--app-card-hover': d.surface, '--app-input-bg': d.input, '--app-canvas-bg': d.canvas, '--app-status-bg': bg,
  }
  for (const k in map) set(k, map[k])
  root.classList.toggle('dark', t.mode === 'dark')
  document.body.style.background = d.canvas
  document.body.style.color = c.foreground
}

const KEY = 'tv_theme'
export function savedThemeId(): string { return localStorage.getItem(KEY) || 'construct' }
export function setThemeId(id: string) { localStorage.setItem(KEY, id) }
export function themeById(id: string): Theme { return THEMES.find(t => t.id === id) || THEMES[0] }
