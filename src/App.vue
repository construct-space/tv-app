<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from 'vue'
import { onToast, type ToastEvent } from './spaces/host'
import { getToken, getIdentity, getRefresh, setSession, setRefresh, clearSession, type Identity } from './spaces/session'
import { listTvSpaces, runSpaceAction, type TvSpace } from './spaces/loader'
import WidgetTile from './spaces/WidgetTile.vue'
import { THEMES, applyTheme, savedThemeId, setThemeId, themeById } from './spaces/themes'

// ---- session / device login ----
const token = ref(getToken() || '')
const identity = ref<Identity | null>(getIdentity())
const code = ref('····-····')
let pollTimer: number | undefined
let refreshTimer: number | undefined

// Exchange the long-lived refresh token for a fresh access token (delegated by
// accounts). Keeps the TV signed in without re-pairing when the token expires.
async function refreshAccessToken(): Promise<boolean> {
  const refresh = getRefresh()
  if (!refresh) return false
  try {
    const r = await fetch('/api/device/token', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh }),
    })
    if (!r.ok) return false
    const d = await r.json()
    if (d.token) {
      setSession(d.token, d.user || identity.value)
      token.value = d.token
      if (d.user) identity.value = d.user
      return true
    }
  } catch { /* offline */ }
  return false
}

async function startPairing() {
  clearInterval(pollTimer)
  try {
    const d = await (await fetch('/api/device/start', { method: 'POST' })).json()
    code.value = d.user_code
    pollTimer = window.setInterval(async () => {
      const res = await fetch('/api/device/poll?device_id=' + encodeURIComponent(d.device_id))
      // Backend restarted (in-memory codes cleared) → this code is dead; re-issue.
      if (res.status === 404) { clearInterval(pollTimer); startPairing(); return }
      const pd = await res.json()
      if (pd.error) { clearInterval(pollTimer); startPairing(); return }
      if (pd.approved && pd.token) {
        clearInterval(pollTimer)
        setSession(pd.token, pd.user || null)
        if (pd.refresh) setRefresh(pd.refresh)
        token.value = pd.token
        identity.value = pd.user || null
        loadWidgets(); loadModels()
      }
    }, 3000)
  } catch { /* backend down */ }
}

// ---- widget canvas ----
interface Tile { space: string; widget: string; size: string; label?: string; key: string }
const tiles = ref<Tile[]>([])
const tvSpaces = ref<TvSpace[]>([])
const heading = ref('')   // set by a voice command, e.g. "Project X"
let tileSeq = 0

const GRID_COLS = 12
function parseSpan(size?: string): { c: number; r: number } {
  const [w, h] = (size || '2x2').split('x').map(Number)
  return { c: Math.min(Math.max(w || 2, 1), GRID_COLS), r: Math.max(h || 2, 1) }
}

// ---- in-widget D-pad navigation ----
// WebView spatial nav can't move between controls inside a widget's shadow DOM
// (arrows escape to the next tile). So once a widget is "entered", we trap arrow
// keys and rove focus across its shadow controls; BACK exits back to the tile.
type ShadowEl = HTMLElement & { shadowRoot?: ShadowRoot }
const enteredHost = ref<ShadowEl | null>(null)
function widgetControls(host: ShadowEl): HTMLElement[] {
  const root = host.shadowRoot
  return root ? Array.from(root.querySelectorAll('button,[tabindex]:not([tabindex="-1"]),input,select,a[href]')) as HTMLElement[] : []
}
function enterWidget(host: ShadowEl): boolean {
  const c = widgetControls(host); if (!c.length) return false
  enteredHost.value = host; c[0].focus(); return true
}
function exitWidget() {
  const host = enteredHost.value; enteredHost.value = null
  ;(host?.closest('[data-tile]') as HTMLElement | null)?.focus()
}
function moveInWidget(dir: number) {
  const host = enteredHost.value; if (!host) return
  const c = widgetControls(host); if (!c.length) return
  const cur = host.shadowRoot?.activeElement as HTMLElement | null
  let i = c.indexOf(cur as HTMLElement); if (i < 0) i = 0
  c[(i + dir + c.length) % c.length].focus()
}

// Default ambient layout: each TV space's default widget.
async function loadWidgets() {
  tvSpaces.value = await listTvSpaces()
  if (!heading.value) showDefault()
}
function showDefault() {
  heading.value = ''
  const nameOf = (id: string) => tvSpaces.value.find(s => s.id === id)?.name || id
  const w = pages.value[activePage.value]?.widgets || []
  if (w.length) {
    tiles.value = w.map(c => ({ space: c.space, widget: c.widget, size: c.size, label: nameOf(c.space), key: `sel-${++tileSeq}` }))
  } else if (pages.value.length === 1) {
    // first run, nothing chosen → ambient default: one widget per space
    tiles.value = tvSpaces.value.flatMap(s =>
      s.tv.slice(0, 1).map(w2 => ({ space: s.id, widget: w2.id, size: w2.defaultSize, label: s.name, key: `def-${++tileSeq}` })),
    )
  } else {
    tiles.value = [] // an empty page the user added
  }
}

// ---- settings ----
const settingsOpen = ref(false)
const ttsEnabled = ref(localStorage.getItem('tv_tts') !== 'off')
const appVersion = 'construct-tv'

// ---- themes ----
const themePickerOpen = ref(false)
const themeId = ref(savedThemeId())
const themeName = computed(() => themeById(themeId.value).name)
function selectTheme(id: string) { themeId.value = id; setThemeId(id); applyTheme(themeById(id)); showDefault() }
function toggleTts() { ttsEnabled.value = !ttsEnabled.value; localStorage.setItem('tv_tts', ttsEnabled.value ? 'on' : 'off') }

// ---- model switching (Kimi / DeepSeek / MiniMax / source-medium …) ----
const models = ref<string[]>([])
const selectedModel = ref(localStorage.getItem('tv_model') || '')
const authHdr = () => (token.value ? { Authorization: 'Bearer ' + token.value } : {})
async function loadModels() {
  try {
    const d = await (await fetch('/api/models', { headers: authHdr() })).json()
    models.value = d.models || []
    if (!selectedModel.value) selectedModel.value = d.selected || models.value[0] || ''
  } catch { /* offline */ }
}
function cycleModel() {
  if (!models.value.length) return
  const i = models.value.indexOf(selectedModel.value)
  selectedModel.value = models.value[(i + 1) % models.value.length]
  localStorage.setItem('tv_model', selectedModel.value)
}

// ---- pages (Home / Project / Company …) ----
interface TvPage { id: string; name: string; widgets: { space: string; widget: string; size: string }[] }
function loadPages(): TvPage[] {
  try { const p = JSON.parse(localStorage.getItem('tv_pages') || 'null'); if (Array.isArray(p) && p.length) return p } catch { /* */ }
  let legacy: { space: string; widget: string; size: string }[] = []
  try { legacy = JSON.parse(localStorage.getItem('tv_widgets') || '[]') } catch { /* */ }
  return [{ id: 'home', name: 'Home', widgets: legacy }]
}
const pages = ref<TvPage[]>(loadPages())
const activePage = ref(0)
function savePages() { localStorage.setItem('tv_pages', JSON.stringify(pages.value)) }
function setPage(i: number) { if (i < 0 || i >= pages.value.length) return; activePage.value = i; showDefault() }
function nextPage() { setPage((activePage.value + 1) % pages.value.length) }
function prevPage() { setPage((activePage.value - 1 + pages.value.length) % pages.value.length) }
function addPage(name?: string) {
  pages.value = [...pages.value, { id: 'p' + Math.random().toString(36).slice(2, 8), name: name || `Page ${pages.value.length + 1}`, widgets: [] }]
  savePages(); setPage(pages.value.length - 1)
}
function renamePage(name: string) { const p = pages.value[activePage.value]; if (p && name) { p.name = name; savePages() } }
function deletePage() {
  if (pages.value.length <= 1) return
  pages.value = pages.value.filter((_, i) => i !== activePage.value)
  if (activePage.value >= pages.value.length) activePage.value = pages.value.length - 1
  savePages(); showDefault()
}

// ---- widget selection (choose which space widgets to place on the active page) ----
const widgetPickerOpen = ref(false)
interface PickW { space: string; widget: string; size: string; name: string; key: string }
const chosen = computed<{ space: string; widget: string; size: string }[]>({
  get: () => pages.value[activePage.value]?.widgets || [],
  set: (v) => { const p = pages.value[activePage.value]; if (p) { p.widgets = v; savePages() } },
})
const allWidgets = computed<PickW[]>(() =>
  tvSpaces.value.flatMap(s => s.tv.map(w => ({
    space: s.id, widget: w.id, size: w.defaultSize,
    name: `${s.name} · ${w.name || w.id}`, key: `${s.id}:${w.id}`,
  }))),
)
function isChosen(w: { space: string; widget: string }) { return chosen.value.some(c => c.space === w.space && c.widget === w.widget) }
function chosenIndex(w: { space: string; widget: string }) { return chosen.value.findIndex(c => c.space === w.space && c.widget === w.widget) }
function persistChosen() { showDefault() } // chosen's setter already persists pages
function toggleWidget(w: PickW) {
  if (isChosen(w)) chosen.value = chosen.value.filter(c => !(c.space === w.space && c.widget === w.widget))
  else chosen.value = [...chosen.value, { space: w.space, widget: w.widget, size: w.size }]
  persistChosen()
}
// Reorder a chosen widget (dir -1 = earlier/up, +1 = later/down). Render order
// follows the chosen array, so this moves the tile in the grid.
function moveWidget(w: { space: string; widget: string }, dir: number) {
  const i = chosenIndex(w); const j = i + dir
  if (i < 0 || j < 0 || j >= chosen.value.length) return
  const next = [...chosen.value]
  ;[next[i], next[j]] = [next[j], next[i]]
  chosen.value = next
  persistChosen()
}
async function refreshWidgets() {
  try { await fetch('/api/tv-spaces?refresh=1', { headers: token.value ? { Authorization: 'Bearer ' + token.value } : {} }) } catch { /* ignore */ }
  await loadWidgets()
  settingsOpen.value = false
}
function unlinkTv() {
  clearSession()
  token.value = ''
  identity.value = null
  tiles.value = []
  settingsOpen.value = false
  startPairing()
}
// Move focus into overlays so the D-pad can navigate them.
watch(settingsOpen, async (open) => {
  if (!open) return
  await nextTick()
  ;(document.querySelector('[data-tv-set-first]') as HTMLElement | null)?.focus()
})
watch(widgetPickerOpen, async (open) => {
  if (!open) return
  await nextTick()
  ;(document.querySelector('[data-tv-pick-first]') as HTMLElement | null)?.focus()
})
watch(themePickerOpen, async (open) => {
  if (!open) return
  await nextTick()
  ;(document.querySelector('[data-tv-theme-first]') as HTMLElement | null)?.focus()
})

// ---- voice / ask: recompose the canvas from the request ----
// Prefer the Android app's native TTS (the WebView has no usable speechSynthesis);
// fall back to the Web Speech API on desktop browsers.
function speak(text: string) {
  // Strip reasoning-model scratchpad tags that sometimes leak into content.
  text = (text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '').trim()
  if (!text) return
  // Record the reply in the conversation overlay BEFORE the mute check, so a
  // muted TV still shows what was said (read it instead of hearing it).
  if (convo.value) { convo.value.reply = text; convo.value.busy = false; bumpConvo() }
  if (!ttsEnabled.value) return
  const av = (window as unknown as { AndroidVoice?: { speak?: (t: string) => void } }).AndroidVoice
  if (av && typeof av.speak === 'function') { try { av.speak(text); return } catch { /* fall through */ } }
  try { window.speechSynthesis?.speak(new SpeechSynthesisUtterance(text)) } catch { /* no tts */ }
}
const partial = ref('')
const summary = ref<{ title: string; points: string[] } | null>(null)

// ---- conversation overlay: shows what you said + what Construct replied, so you
// can read the exchange (useful when TTS is muted). Dismiss with BACK (←).
const convo = ref<{ user: string; reply: string; busy: boolean } | null>(null)
let convoTimeout: number | undefined
function bumpConvo(ms = 14000) {
  if (convoTimeout) clearTimeout(convoTimeout)
  convoTimeout = window.setTimeout(() => { convo.value = null }, ms)
}
function openConvo(user: string) { convo.value = { user, reply: '', busy: true }; bumpConvo(30000) }
function dismissConvo() { convo.value = null; if (convoTimeout) clearTimeout(convoTimeout) }

// ---- voice → clock timer/alarm (create scheduler tasks the clock widgets read) ----
function tz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' } }
async function schedulerCreate(body: Record<string, unknown>) {
  return fetch('/api/source/scheduler/tasks', { method: 'POST', headers: { 'content-type': 'application/json', ...authHdr() }, body: JSON.stringify(body) })
}
function clockSize(widget: string): string {
  return tvSpaces.value.find(s => s.id === 'clock')?.tv.find(w => w.id === widget)?.defaultSize || '2x2'
}
function showClock(widget: string, label: string) {
  heading.value = label
  tiles.value = [{ space: 'clock', widget, size: clockSize(widget), label, key: `clk-${++tileSeq}` }]
}
function parseDurationSecs(q: string): number | null {
  let s = 0, found = false
  const h = q.match(/(\d+)\s*(?:h|hours?|hrs?)\b/i); if (h) { s += +h[1] * 3600; found = true }
  const m = q.match(/(\d+)\s*(?:m|mins?|minutes?)\b/i); if (m) { s += +m[1] * 60; found = true }
  const sec = q.match(/(\d+)\s*(?:s|secs?|seconds?)\b/i); if (sec) { s += +sec[1]; found = true }
  if (!found) { const n = q.match(/\b(\d+)\b/); if (n) { s = +n[1] * 60; found = true } } // bare number → minutes
  return found && s > 0 ? s : null
}
function parseAlarmTime(q: string): string | null {
  let m = q.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i)
  if (m) { let h = +m[1] % 12; if (/pm/i.test(m[3])) h += 12; const mn = m[2] ? +m[2] : 0; return `${String(h).padStart(2, '0')}:${String(mn).padStart(2, '0')}` }
  m = q.match(/\b(\d{1,2}):(\d{2})\b/); if (m) return `${String(+m[1]).padStart(2, '0')}:${m[2]}`
  return null
}
function nextAtISO(hhmm: string): string {
  const [h, mn] = hhmm.split(':').map(Number)
  const d = new Date(); d.setHours(h, mn, 0, 0)
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1)
  return d.toISOString()
}
// Beep out the TV speaker (Web Audio — no asset needed) when a timer fires.
function playAlarmSound() {
  try {
    const AC = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)
    const ctx = new AC()
    const beep = (t0: number) => {
      const o = ctx.createOscillator(), g = ctx.createGain()
      o.connect(g); g.connect(ctx.destination); o.type = 'sine'; o.frequency.value = 880
      g.gain.setValueAtTime(0.0001, t0)
      g.gain.exponentialRampToValueAtTime(0.4, t0 + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.45)
      o.start(t0); o.stop(t0 + 0.5)
    }
    const t = ctx.currentTime; for (let i = 0; i < 4; i++) beep(t + i * 0.6)
  } catch { /* no audio */ }
}

let timerTimeout: number | undefined
let timerTaskId: string | null = null
async function cancelTimer() {
  if (timerTimeout) { clearTimeout(timerTimeout); timerTimeout = undefined }
  if (timerTaskId) { try { await fetch('/api/source/scheduler/tasks/' + timerTaskId, { method: 'DELETE', headers: authHdr() }) } catch { /* ignore */ } timerTaskId = null }
}

// ---- firing alert (visual + sound + voice when a timer/alarm/reminder goes off) ----
const firing = ref<{ title: string } | null>(null)
const alerted = new Set<string>()
let firingTimeout: number | undefined
function fireAlert(title: string, taskId?: string, once = true) {
  if (taskId) { if (alerted.has(taskId)) return; alerted.add(taskId) }
  firing.value = { title: title || 'Reminder' }
  playAlarmSound()
  speak(title || 'Reminder')
  if (firingTimeout) clearTimeout(firingTimeout)
  firingTimeout = window.setTimeout(() => { firing.value = null }, 90000) // auto-dismiss
  if (taskId && once) fetch('/api/source/scheduler/tasks/' + taskId, { method: 'DELETE', headers: authHdr() }).catch(() => {})
}
function dismissFiring() { firing.value = null; if (firingTimeout) clearTimeout(firingTimeout) }

// Poll the clock scheduler so timers/alarms/reminders fire on the TV (visual +
// sound + voice) even after a reload or for clock-time alarms — the TV's own
// lightweight version of the desktop's scheduler runner.
let pollSchedTimer: number | undefined
async function pollScheduler() {
  if (!token.value) return
  try {
    const r = await fetch('/api/source/scheduler/tasks?owner_space=clock&enabled=true', { headers: authHdr() })
    if (!r.ok) return
    const { tasks = [] } = await r.json() as { tasks?: Array<{ id: string; title?: string; next_run_at?: string; schedule?: { kind?: string }; action?: { label?: string; kind?: string } }> }
    const now = Date.now()
    for (const t of tasks) {
      if (!t.next_run_at) continue
      if (new Date(t.next_run_at).getTime() <= now) {
        const once = (t.schedule?.kind || 'once') === 'once'
        const label = t.action?.label || (t.action?.kind === 'clock.timer' ? "Time's up!" : t.title) || 'Reminder'
        fireAlert(label, t.id, once)
      }
    }
  } catch { /* offline */ }
}

// Returns true if the request was a timer/alarm command (handled locally).
async function maybeTimerAlarm(q: string): Promise<boolean> {
  const cancelIntent = /\b(cancel|stop|clear|delete|remove)\b/i.test(q)
  if (/\btimer\b/i.test(q) && cancelIntent) {
    await cancelTimer(); speak('Timer cancelled.'); showDefault(); return true
  }
  // "remind me to drink water in 30 minutes / at 3pm" → a named reminder. Stored
  // as a scheduler task with a notify block so the platform rings it across the
  // user's devices (desktop/mobile runners); the TV also rings locally if soon.
  if (/\bremind me\b/i.test(q)) {
    const secs = parseDurationSecs(q)
    const time = parseAlarmTime(q)
    let label = (q.match(/remind me (?:to |about |that )?(.+)/i)?.[1] || 'Reminder')
    label = label.replace(/\b(in|at|every|after|by|on)\b.*$/i, '').replace(/[.?!,]+$/, '').trim() || 'Reminder'
    const title = label.charAt(0).toUpperCase() + label.slice(1)
    let schedule: Record<string, unknown> | null = null, when = '', atTime = time || ''
    if (time) { schedule = { kind: 'once', at: nextAtISO(time), timezone: tz() }; when = `at ${time}` }
    else if (secs) {
      const target = new Date(Date.now() + secs * 1000)
      atTime = `${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`
      schedule = { kind: 'once', at: target.toISOString(), timezone: tz() }
      when = secs >= 60 ? `in ${Math.round(secs / 60)} minutes` : `in ${secs} seconds`
    }
    if (!schedule) { speak("When should I remind you? Try 'remind me to drink water in 30 minutes'."); return true }
    let remId: string | undefined
    try {
      const rr = await schedulerCreate({ owner_space: 'clock', title, schedule,
        action: { kind: 'clock.alarm', time: atTime, label: title, days: [],
          notify: { title, body: 'Reminder from your TV', source: 'tv', sound: true } } })
      remId = (await rr.json().catch(() => ({})))?.id
    } catch { /* ignore */ }
    if (secs && secs < 6 * 3600) window.setTimeout(() => fireAlert(title, remId), secs * 1000)
    speak(`Okay, I'll remind you to ${label} ${when}.`)
    showClock('alarm', 'Reminder'); return true
  }
  if (/\btimer\b/i.test(q) || /\bremind me in\b/i.test(q)) {
    const secs = parseDurationSecs(q); if (!secs) return false
    await cancelTimer() // one active timer at a time
    try {
      const r = await schedulerCreate({ owner_space: 'clock', title: 'Timer',
        schedule: { kind: 'once', at: new Date(Date.now() + secs * 1000).toISOString(), timezone: tz() },
        action: { kind: 'clock.timer', notify: { title: 'Timer finished', body: "Time's up!", source: 'clock', sound: true } } })
      const d = await r.json().catch(() => ({})); timerTaskId = d.id || null
    } catch { /* ignore */ }
    // Ring + announce when it elapses (TV has no background scheduler runner).
    timerTimeout = window.setTimeout(() => { fireAlert("Time's up!", timerTaskId || undefined); timerTaskId = null }, secs * 1000)
    const mins = Math.round(secs / 60)
    speak(secs >= 60 ? `Timer set for ${mins} minute${mins > 1 ? 's' : ''}.` : `Timer set for ${secs} seconds.`)
    showClock('timer', 'Timer'); return true
  }
  if (/\balarm\b/i.test(q)) {
    const time = parseAlarmTime(q); if (!time) return false
    // Additive — each command adds another alarm (multiple alarms, like desktop).
    try {
      await schedulerCreate({ owner_space: 'clock', title: `Alarm ${time}`,
        schedule: { kind: 'once', at: nextAtISO(time), timezone: tz() },
        action: { kind: 'clock.alarm', time, label: '', days: [], notify: { title: 'Alarm', source: 'clock', sound: true } } })
    } catch { /* ignore */ }
    speak(`Alarm set for ${time}.`); showClock('alarm', 'Alarm'); return true
  }
  return false
}
// Read aloud when the request is a question or an explicit read/summarize ask
// ("what's my week", "how's my day", "any mail", "summarize the news", "top 5 …").
const isSummarizeIntent = (q: string) => {
  const s = q.trim()
  return /^(what|whats|what's|how|hows|how's|when|who|do i|did i|is there|are there|any|give me|tell me|read|summari|brief|recap|catch me up)\b/i.test(s)
    || /\b(summari[sz]e|read|recap|brief|top \d|latest|what'?s new|my (day|week))\b/i.test(s)
}

// Page navigation by voice: "next/previous page", "page 2", "go to project",
// "new page called Company", "rename page to Project".
function maybePageCommand(q: string): boolean {
  const s = q.toLowerCase().trim()
  if (/\bnext page\b/.test(s)) { nextPage(); speak(pages.value[activePage.value].name); return true }
  if (/\b(previous|prev|last) page\b/.test(s)) { prevPage(); speak(pages.value[activePage.value].name); return true }
  const pn = s.match(/\bpage (\d+)\b/); if (pn) { setPage(+pn[1] - 1); speak(pages.value[activePage.value].name); return true }
  const np = s.match(/\b(?:new|create|add)\s+(?:a\s+)?page(?:\s+(?:called|named)\s+(.+))?$/)
  if (np) { addPage(np[1]?.trim()); speak(`Added ${pages.value[activePage.value].name}`); return true }
  const rn = s.match(/\brename\s+(?:this\s+)?page\s+(?:to\s+)?(.+)$/)
  if (rn) { renamePage(rn[1].trim()); speak('Renamed'); return true }
  const go = s.match(/\b(?:go to|switch to|open|show)\s+(.+?)(?:\s+page)?$/)
  if (go) {
    const t = go[1].trim()
    const i = pages.value.findIndex(p => p.name.toLowerCase() === t || (t.length > 2 && p.name.toLowerCase().includes(t)))
    if (i >= 0) { setPage(i); speak(pages.value[i].name); return true }
  }
  return false
}

// Arrangement-aware LLM layout editor. Sends the CURRENT pages + the request so
// the model can add/remove/move widgets, create/rename pages, or answer
// ("what's on page 3"). Returns the updated pages.
function isArrangeIntent(q: string): boolean {
  if (/\bpage\b/i.test(q)) return true
  return /\b(put|add|place|move|arrange|organi[sz]e|set ?up|setup|fill|rearrange|clean ?up|clear|remove|reset)\b/i.test(q)
    && /\b(widget|board|mail|calendar|weather|clock|news|finance|task|issue|habit|journal|pulse|subscription|company|project|org|stock|net ?worth|inbox|dashboard|screen|here)\b/i.test(q)
}
async function maybeArrange(q: string): Promise<boolean> {
  if (!isArrangeIntent(q)) return false
  speak('One moment.')
  try {
    const r = await fetch('/api/arrange', {
      method: 'POST', headers: { 'content-type': 'application/json', ...authHdr() },
      body: JSON.stringify({
        query: q, active: activePage.value, model: selectedModel.value || undefined,
        pages: pages.value.map(p => ({ name: p.name, widgets: p.widgets })),
      }),
    })
    const d = await r.json()
    if (Array.isArray(d.pages) && d.pages.length) {
      pages.value = d.pages.map((p: { name?: string; widgets?: { space: string; widget: string; size?: string }[] }, i: number) => ({
        id: pages.value.find(o => o.name === p.name)?.id || ('p' + Math.random().toString(36).slice(2, 8)),
        name: p.name || `Page ${i + 1}`,
        widgets: (p.widgets || []).filter(w => w.space && w.widget).map(w => {
          const sp = tvSpaces.value.find(s => s.id === w.space)
          const def = sp?.tv.find(t => t.id === w.widget)
          return { space: w.space, widget: w.widget, size: w.size || def?.defaultSize || '2x2' }
        }),
      }))
      savePages()
      const goto = typeof d.goto === 'number' ? d.goto : activePage.value
      setPage(Math.max(0, Math.min(goto, pages.value.length - 1)))
    }
    speak(d.speak || 'Done.')
  } catch { speak('Sorry, that did not work.') }
  return true
}

// ---- space actions: "do something" in a space (create issue, add event, move
// ticket…). Routed to /api/act, which runs a tool-calling agent over the spaces'
// declared actions and executes them headless via the space-runtime. Distinct
// from arrange (layout): an action names DATA (task/issue/event), not a widget.
function isActionIntent(q: string): boolean {
  const s = q.toLowerCase()
  const verb = /\b(create|add|new|schedule|make|file|raise|log|assign|invite|move|rename|delete|remove|mark|complete|close|update|change|comment|break ?down|generate)\b/
  const dataNoun = /\b(task|issue|ticket|event|meeting|appointment|sub-?issue|comment|cycle|sprint|label)\b/
  if (verb.test(s) && dataNoun.test(s)) return true
  // "create a project/board/calendar called X"
  if (/\b(create|new|make|add|generate)\b/.test(s) && /\b(project|board|calendar)\b/.test(s) && (/\b(called|named|titled|for|about)\b/.test(s) || /["'“”]/.test(q))) return true
  return false
}

// Force the tiles of the given spaces to remount so they re-fetch fresh data
// after an action mutated the graph.
function refreshSpaces(ids: string[]) {
  const set = new Set(ids)
  tiles.value = tiles.value.map(t => (set.has(t.space) ? { ...t, key: `act-${++tileSeq}` } : t))
}

// Drive the action loop: the backend plans (model + catalog), we execute each
// tool call in the loaded space bundle, then feed results back until done.
interface ActStep { done?: boolean; speak?: string; messages?: unknown[]; tool_calls?: { id: string; space: string; action: string; args?: string }[] }
async function maybeAction(q: string): Promise<boolean> {
  if (!isActionIntent(q)) return false
  speak('On it.')
  const affected = new Set<string>()
  try {
    let messages: unknown[] | undefined
    let toolResults: { id: string; content: string }[] | undefined
    for (let step = 0; step < 6; step++) {
      const r = await fetch('/api/act', {
        method: 'POST', headers: { 'content-type': 'application/json', ...authHdr() },
        body: JSON.stringify({ query: q, model: selectedModel.value || undefined, messages, tool_results: toolResults }),
      })
      const d = await r.json() as ActStep
      if (d.done || !d.tool_calls?.length) {
        if (affected.size) refreshSpaces([...affected])
        speak(d.speak || 'Done.')
        return true
      }
      messages = d.messages
      toolResults = []
      for (const tc of d.tool_calls) {
        if (tc.space) affected.add(tc.space)
        let content: string
        try {
          let args: Record<string, unknown> = {}
          try { args = tc.args ? JSON.parse(tc.args) : {} } catch { /* bad args json */ }
          const result = await runSpaceAction(tc.space, tc.action, args)
          content = JSON.stringify(result ?? { ok: true })
        } catch (e) { content = 'ERROR: ' + (e instanceof Error ? e.message : String(e)) }
        toolResults.push({ id: tc.id, content: content.slice(0, 4000) })
      }
    }
    if (affected.size) refreshSpaces([...affected])
    speak('That took too many steps — please check the result.')
  } catch { speak('Sorry, that did not work.') }
  return true
}

async function ask(q: string) {
  q = (q || '').trim(); if (!q) return
  partial.value = q
  summary.value = null
  openConvo(q)
  // theme: "dark mode", "light mode", "theme dracula", "use the nord theme"
  if (/\b(theme|dark mode|light mode)\b/i.test(q)) {
    const s = q.toLowerCase()
    let t = THEMES.find(x => s.includes(x.name.toLowerCase()) || s.includes(x.id))
    if (!t && /\blight mode\b/.test(s)) t = themeById('vs')
    if (!t && /\bdark mode\b/.test(s)) t = themeById('vs-dark')
    if (t) { selectTheme(t.id); speak(`${t.name} theme`); window.setTimeout(() => (partial.value = ''), 1200); return }
  }
  // Data actions (create issue, add event, move ticket) win over layout arrange.
  if (await maybeAction(q)) { window.setTimeout(() => (partial.value = ''), 1500); return }
  if (await maybeArrange(q)) { window.setTimeout(() => (partial.value = ''), 1200); return }
  if (maybePageCommand(q)) { window.setTimeout(() => (partial.value = ''), 1200); return }
  // Timer/alarm commands are handled locally (create a scheduler task the clock
  // widgets read) — no model needed.
  if (await maybeTimerAlarm(q)) { window.setTimeout(() => (partial.value = ''), 1500); return }
  try {
    const r = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHdr() },
      body: JSON.stringify({ query: q, model: selectedModel.value || undefined }),
    })
    const spec = (await r.json()).spec || {}
    if (Array.isArray(spec.widgets) && spec.widgets.length) {
      heading.value = spec.title || q
      tiles.value = spec.widgets
        .filter((w: { space?: string; widget?: string }) => w.space && w.widget)
        .map((w: { space: string; widget: string; size?: string }) => {
          const sp = tvSpaces.value.find(s => s.id === w.space)
          const def = sp?.tv.find(d => d.id === w.widget)
          return { space: w.space, widget: w.widget, size: w.size || def?.defaultSize || '2x2', label: sp?.name, key: `ask-${++tileSeq}` }
        })
      // If the user asked to read/summarize, scrape the rendered widget(s) and summarize.
      if (isSummarizeIntent(q)) { await nextTick(); window.setTimeout(() => summarize(q), 1200) }
    }
    if (spec.speak) speak(spec.speak)
  } catch { /* offline */ }
  finally { window.setTimeout(() => (partial.value = ''), 1500) }
}

// Scrape the visible text of the rendered widget tiles (shadow DOM is open) and
// ask the backend to summarize/read it aloud.
async function summarize(q: string) {
  // Read only the widget's RENDERED content (.widget-root), not the shadow root's
  // textContent — that would include the injected <style>/CSS we add for theming.
  const text = Array.from(document.querySelectorAll('.tv-tile'))
    .map(el => {
      const root = (el as HTMLElement).shadowRoot?.querySelector('.widget-root') as HTMLElement | null
      return (root?.innerText || '').trim()
    })
    .filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!text) return
  try {
    const r = await fetch('/api/summarize', {
      method: 'POST', headers: { 'content-type': 'application/json', ...authHdr() },
      body: JSON.stringify({ query: q, text: text.slice(0, 6000), model: selectedModel.value || undefined }),
    })
    const s = await r.json()
    if (s.speak) speak(s.speak)
    summary.value = { title: s.title || heading.value, points: Array.isArray(s.points) ? s.points : [] }
  } catch { /* offline */ }
}

// Android BACK / "home": dismiss a firing alert, exit a widget, close overlays…
function jarvisHome() {
  if (firing.value) { dismissFiring(); return }
  if (convo.value) { dismissConvo(); return }
  if (enteredHost.value) { exitWidget(); return }
  if (themePickerOpen.value) { themePickerOpen.value = false; return }
  if (widgetPickerOpen.value) { widgetPickerOpen.value = false; return }
  if (settingsOpen.value) { settingsOpen.value = false; return }
  if (summary.value) { summary.value = null; return }
  showDefault()
}

// ---- toasts ----
const toasts = ref<ToastEvent[]>([])
let offToast: (() => void) | undefined
function pushToast(t: ToastEvent) {
  toasts.value = [...toasts.value, t]
  window.setTimeout(() => { toasts.value = toasts.value.filter(x => x.id !== t.id) }, 4000)
}

// ---- clock / weather (built-in ambient) ----
const now = ref(new Date())
let clockTimer: number | undefined
const p2 = (n: number) => String(n).padStart(2, '0')
const hhmm = computed(() => `${p2(now.value.getHours())}:${p2(now.value.getMinutes())}`)
const ss = computed(() => p2(now.value.getSeconds()))
const dateLine = computed(() => now.value.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }))
const greeting = computed(() => { const h = now.value.getHours(); return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening' })
const who = computed(() => identity.value?.name || identity.value?.email || 'Construct')
const firstName = computed(() => (identity.value?.name || '').trim().split(/\s+/)[0] || '')
const wx = ref<{ city?: string; current?: { temperature_2m?: number } } | null>(null)
async function loadWeather() { try { wx.value = await (await fetch('/api/weather')).json() } catch { /* offline */ } }

onMounted(async () => {
  applyTheme(themeById(themeId.value))
  offToast = onToast(pushToast)
  clockTimer = window.setInterval(() => (now.value = new Date()), 1000)
  loadWeather(); window.setInterval(loadWeather, 600000)
  if (!token.value && !getRefresh()) {
    startPairing()
  } else {
    // Mint a fresh access token from the refresh token before loading data, so
    // an expired stored token doesn't break widgets/models. Re-mint every 45m.
    if (getRefresh()) await refreshAccessToken()
    loadWidgets(); loadModels()
    refreshTimer = window.setInterval(() => { void refreshAccessToken() }, 45 * 60 * 1000)
    pollScheduler(); pollSchedTimer = window.setInterval(() => { void pollScheduler() }, 20000)
  }
  const w = window as unknown as {
    jarvisAsk: (q: string) => void; jarvisHome: () => void
    jarvisPartial: (t: string) => void; jarvisSettings: () => void
  }
  w.jarvisAsk = (q: string) => ask(q)
  w.jarvisHome = jarvisHome
  w.jarvisPartial = (t: string) => {
    partial.value = t
    if (!t) return
    // Live transcript in the overlay. If the last exchange already has a reply,
    // a new utterance starts a fresh card; otherwise keep updating the current.
    if (!convo.value || convo.value.reply) convo.value = { user: t, reply: '', busy: false }
    else convo.value.user = t
    bumpConvo(30000)
  }
  w.jarvisSettings = () => { settingsOpen.value = !settingsOpen.value }
  // OK handler for the remote: drill through shadow DOM to the truly-focused
  // element. On a widget TILE, first OK ENTERS the widget (focuses its first
  // control); subsequent OK activates that control — so widgets (stopwatch,
  // change-city, etc.) become operable with the remote.
  ;(window as unknown as { __tvOk: () => void }).__tvOk = () => {
    if (firing.value) { dismissFiring(); return }
    // Inside a widget → activate the focused control.
    if (enteredHost.value) {
      const el = enteredHost.value.shadowRoot?.activeElement as HTMLElement | null
      if (el && typeof el.click === 'function') el.click()
      return
    }
    // On a widget tile → enter it (focus its first control).
    const active = document.activeElement as HTMLElement | null
    if (active && active.dataset && active.dataset.tile !== undefined) {
      const host = active.querySelector('.tv-tile') as ShadowEl | null
      if (host && enterWidget(host)) return
    }
    // Otherwise (gear, settings, launcher buttons) → click it.
    if (active && typeof active.click === 'function') active.click()
  }
  // While inside a widget, arrows rove its controls instead of escaping to the
  // next tile (WebView spatial nav can't traverse the widget's shadow DOM).
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!enteredHost.value) return
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); moveInWidget(-1) }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); moveInWidget(1) }
  }, true)
  // Land focus on the gear so short-press OK can open settings (retry until it sticks).
  for (const t of [300, 900, 1800]) {
    window.setTimeout(() => {
      if (!document.activeElement || document.activeElement === document.body) {
        (document.querySelector('[data-tv-autofocus]') as HTMLElement | null)?.focus()
      }
    }, t)
  }
})
onUnmounted(() => { clearInterval(clockTimer); clearInterval(pollTimer); clearInterval(refreshTimer); clearInterval(pollSchedTimer); offToast?.() })
</script>

<template>
  <!-- pairing -->
  <div v-if="!token" class="h-screen flex flex-col items-center justify-center gap-6 text-center px-10">
    <div class="text-3xl font-semibold">Link this TV</div>
    <p class="text-[var(--c-muted)] max-w-md">In <b>Construct desktop → Settings → Profile → Link a TV</b>, enter this code:</p>
    <div class="text-[clamp(48px,8vw,92px)] font-bold tracking-widest text-[var(--c-accent)]">{{ code }}</div>
    <div class="text-sm text-[var(--c-muted)]">Waiting for the desktop to link…</div>
    <button
      data-tv-autofocus
      class="mt-2 px-5 py-2 rounded-lg border border-[var(--c-border)] bg-[var(--c-card)] text-sm text-[var(--c-muted)] outline-none focus:ring-2 focus:ring-[var(--c-accent)] focus:text-[var(--c-fg)] transition-colors"
      @click="startPairing"
    >New code</button>
  </div>

  <!-- widget canvas -->
  <div v-else class="h-screen flex flex-col p-8 gap-6 overflow-hidden">
    <!-- ambient header -->
    <header class="flex items-center justify-between shrink-0">
      <div class="flex items-center gap-4">
        <svg class="w-10 h-10 text-[var(--c-accent)] shrink-0" viewBox="0 0 533 533" fill="currentColor" aria-label="Construct">
          <path d="M266.5 410.156C230.912 410.156 199.106 402.203 171.081 386.297C143.056 370.39 121.036 348.519 105.022 320.684C89.0072 292.848 81 261.256 81 225.909C81 190.12 89.0072 158.308 105.022 130.472C121.036 102.636 143.056 80.7655 171.081 64.8593C199.106 48.9531 230.912 41 266.5 41C302.087 41 333.671 48.9531 361.252 64.8593C389.277 80.7655 411.297 102.636 427.311 130.472C443.326 158.308 451.555 190.12 452 225.909C452 261.256 443.77 292.848 427.311 320.684C411.297 348.519 389.277 370.39 361.252 386.297C333.671 402.203 302.087 410.156 266.5 410.156ZM266.5 363.763C292.301 363.763 315.433 357.798 335.896 345.868C356.359 333.939 372.373 317.591 383.939 296.824C395.505 276.058 401.288 252.42 401.288 225.909C401.288 199.399 395.505 175.761 383.939 154.994C372.373 133.786 356.359 117.217 335.896 105.287C315.433 93.3579 292.301 87.393 266.5 87.393C240.699 87.393 217.567 93.3579 197.104 105.287C176.641 117.217 160.405 133.786 148.394 154.994C136.828 175.761 131.045 199.399 131.045 225.909C131.045 252.42 136.828 276.058 148.394 296.824C160.405 317.591 176.641 333.939 197.104 345.868C217.567 357.798 240.699 363.763 266.5 363.763Z"/>
          <path d="M378.22 451.578C393.077 451.578 405.121 460.85 405.121 472.289C405.121 483.727 393.077 493 378.22 493H160.945C146.089 493 134.044 483.727 134.044 472.289C134.044 460.85 146.089 451.578 160.945 451.578H378.22Z"/>
        </svg>
        <div>
          <div class="text-3xl font-light text-[var(--c-muted)]">{{ greeting }}<template v-if="firstName">, <span class="text-[var(--c-fg)] font-semibold">{{ firstName }}</span></template><span class="text-[var(--c-fg)] font-semibold">.</span></div>
          <div class="text-sm text-[var(--c-muted)] mt-1">{{ who }}<span v-if="heading"> · <span class="text-[var(--c-accent)]">{{ heading }}</span></span></div>
        </div>
      </div>
      <button
        data-tv-autofocus
        class="w-11 h-11 rounded-full border border-[var(--c-border)] bg-[var(--c-card)] flex items-center justify-center text-[var(--c-muted)] outline-none focus:ring-2 focus:ring-[var(--c-accent)] focus:text-[var(--c-accent)] transition-colors shrink-0"
        title="Settings" @click="settingsOpen = true"
      >
        <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </button>
    </header>

    <!-- page tabs (Home / Project / Company …) -->
    <nav v-if="pages.length > 1" class="flex items-center gap-2 shrink-0">
      <button
        v-for="(p, i) in pages" :key="p.id"
        class="px-4 py-1.5 rounded-full text-sm font-medium outline-none transition-colors focus:ring-2 focus:ring-[var(--c-accent)]"
        :class="i === activePage ? 'bg-[var(--c-accent)] text-[var(--c-accent-fg)]' : 'bg-[var(--c-surface)] text-[var(--c-muted)]'"
        @click="setPage(i)"
      >{{ p.name }}</button>
    </nav>

    <!-- widget grid -->
    <main class="flex-1 min-h-0 overflow-auto">
      <div v-if="tiles.length" class="grid grid-cols-12 auto-rows-[140px] gap-4 [grid-auto-flow:dense]">
        <div
          v-for="t in tiles" :key="t.key"
          data-tile tabindex="0"
          class="rounded-lg outline-none focus:ring-2 focus:ring-[var(--c-accent)] focus:ring-offset-2 focus:ring-offset-[var(--c-bg)]"
          :style="{ gridColumn: `span ${parseSpan(t.size).c}`, gridRow: `span ${parseSpan(t.size).r}` }"
        >
          <WidgetTile :space-id="t.space" :widget-id="t.widget" :size-key="t.size" :label="t.label" />
        </div>
      </div>
      <div v-else class="h-full flex flex-col items-center justify-center text-center gap-3 text-[var(--c-muted)]">
        <div class="text-2xl font-light">No TV widgets yet<span class="text-[var(--c-accent)]">.</span></div>
        <div class="text-sm max-w-md">Install spaces that ship TV widgets (a non-empty <code>tv</code> in their manifest), or press OK and ask — e.g. “how is my day”.</div>
      </div>
    </main>

    <!-- voice hint / partial -->
    <footer class="shrink-0 text-sm text-[var(--c-muted)] flex items-center gap-2">
      <span class="text-[var(--c-accent)]">●</span>
      <span v-if="partial">{{ partial }}</span>
      <span v-else>Hold OK to talk · BACK for home</span>
    </footer>

    <!-- conversation overlay: what you said + what Construct replied (read it when
         TTS is muted). Hidden while a summary/firing overlay owns the screen.
         Dismiss with BACK (←). -->
    <div v-if="convo && !summary && !firing" class="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-sm p-10" @click.self="dismissConvo">
      <div class="w-full max-w-[860px] rounded-2xl border border-[var(--c-border)] bg-[var(--c-card)] p-8 space-y-6">
        <div class="space-y-2">
          <div class="text-[11px] uppercase tracking-widest font-medium text-[var(--c-muted)]">You</div>
          <div class="text-3xl font-light leading-snug">{{ convo.user }}</div>
        </div>
        <div class="border-t border-[var(--c-border)]"></div>
        <div class="space-y-2">
          <div class="text-[11px] uppercase tracking-widest font-medium text-[var(--c-accent)] flex items-center gap-2">
            Construct
            <span v-if="!ttsEnabled" class="text-[var(--c-muted)] normal-case tracking-normal font-normal">· muted</span>
          </div>
          <div v-if="convo.busy" class="text-2xl font-light text-[var(--c-muted)] animate-pulse">Thinking…</div>
          <div v-else-if="convo.reply" class="text-3xl font-light leading-snug text-[var(--c-fg)]">{{ convo.reply }}</div>
          <div v-else class="text-2xl font-light text-[var(--c-muted)] animate-pulse">Listening…</div>
        </div>
        <div class="flex justify-end pt-1">
          <span class="text-xs text-[var(--c-muted)]">Press <span class="text-[var(--c-fg)] font-medium">←</span> to dismiss</span>
        </div>
      </div>
    </div>

    <!-- settings -->
    <div v-if="settingsOpen" class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-40" @click.self="settingsOpen = false">
      <div class="w-[560px] rounded-2xl border border-[var(--c-border)] bg-[var(--c-card)] p-6">
        <div class="text-xs uppercase tracking-widest text-[var(--c-muted)] mb-4">Settings<span class="text-[var(--c-accent)]">.</span></div>

        <div class="rounded-xl border border-[var(--c-border)] bg-[var(--c-surface)] p-4 mb-4">
          <div class="text-sm font-medium">{{ who }}</div>
          <div class="text-xs text-[var(--c-muted)]">{{ identity?.email || 'Signed in to this TV' }}</div>
        </div>

        <div class="flex flex-col gap-2">
          <button data-tv-set-first class="flex items-center justify-between px-4 py-3 rounded-lg bg-[var(--c-surface)] text-left outline-none focus:ring-2 focus:ring-[var(--c-accent)] transition-colors" @click="widgetPickerOpen = true; settingsOpen = false">
            <span class="text-sm font-medium">Choose widgets</span>
            <span class="text-xs text-[var(--c-muted)]">{{ chosen.length ? chosen.length + ' selected' : 'auto (all)' }}</span>
          </button>
          <button class="flex items-center justify-between px-4 py-3 rounded-lg bg-[var(--c-surface)] text-left outline-none focus:ring-2 focus:ring-[var(--c-accent)] transition-colors" @click="cycleModel">
            <span class="text-sm font-medium">Model</span>
            <span class="text-xs font-semibold text-[var(--c-accent)]">{{ selectedModel || '—' }}</span>
          </button>
          <button class="flex items-center justify-between px-4 py-3 rounded-lg bg-[var(--c-surface)] text-left outline-none focus:ring-2 focus:ring-[var(--c-accent)] transition-colors" @click="themePickerOpen = true; settingsOpen = false">
            <span class="text-sm font-medium">Theme</span>
            <span class="text-xs font-semibold text-[var(--c-accent)]">{{ themeName }}</span>
          </button>
          <button class="flex items-center justify-between px-4 py-3 rounded-lg bg-[var(--c-surface)] text-left outline-none focus:ring-2 focus:ring-[var(--c-accent)] transition-colors" @click="refreshWidgets">
            <span class="text-sm font-medium">Refresh widgets</span>
            <span class="text-xs text-[var(--c-muted)]">re-scan installed spaces</span>
          </button>
          <button class="flex items-center justify-between px-4 py-3 rounded-lg bg-[var(--c-surface)] text-left outline-none focus:ring-2 focus:ring-[var(--c-accent)] transition-colors" @click="toggleTts">
            <span class="text-sm font-medium">Speak replies</span>
            <span class="text-xs font-semibold" :class="ttsEnabled ? 'text-[var(--c-accent)]' : 'text-[var(--c-muted)]'">{{ ttsEnabled ? 'ON' : 'OFF' }}</span>
          </button>
          <button class="flex items-center justify-between px-4 py-3 rounded-lg bg-[var(--c-surface)] text-left outline-none focus:ring-2 focus:ring-red-500 transition-colors" @click="unlinkTv">
            <span class="text-sm font-medium text-red-400">Unlink this TV</span>
            <span class="text-xs text-[var(--c-muted)]">sign out &amp; show pairing code</span>
          </button>
        </div>

        <div class="text-[10px] uppercase tracking-widest text-[var(--c-muted)] mt-5 flex justify-between">
          <span>{{ appVersion }}</span>
          <span>tv.construct.space</span>
        </div>
      </div>
    </div>

    <!-- widget picker — right-side drawer so the live canvas stays visible behind it -->
    <div v-if="widgetPickerOpen" class="fixed inset-y-0 right-0 w-[460px] bg-[var(--c-card)]/95 backdrop-blur-sm border-l border-[var(--c-border)] shadow-2xl z-40 p-5 overflow-auto">
        <div class="text-xs uppercase tracking-widest text-[var(--c-muted)] mb-1">Choose widgets<span class="text-[var(--c-accent)]">.</span></div>
        <div class="text-xs text-[var(--c-muted)] mb-3">Editing <b class="text-[var(--c-fg)]">{{ pages[activePage]?.name }}</b> · toggle to place · ↑↓ reorder · BACK to close.</div>
        <!-- page management -->
        <div class="flex items-center gap-2 mb-3 flex-wrap">
          <button
            v-for="(p, i) in pages" :key="p.id"
            class="px-3 py-1 rounded-full text-xs font-medium outline-none focus:ring-2 focus:ring-[var(--c-accent)]"
            :class="i === activePage ? 'bg-[var(--c-accent)] text-[var(--c-accent-fg)]' : 'bg-[var(--c-surface)] text-[var(--c-muted)]'"
            @click="setPage(i)"
          >{{ p.name }}</button>
          <button class="px-3 py-1 rounded-full text-xs bg-[var(--c-surface)] text-[var(--c-muted)] outline-none focus:ring-2 focus:ring-[var(--c-accent)]" @click="addPage()">+ Page</button>
          <button v-if="pages.length > 1" class="px-3 py-1 rounded-full text-xs bg-[var(--c-surface)] text-red-400 outline-none focus:ring-2 focus:ring-red-500" @click="deletePage()">Delete page</button>
        </div>
        <div class="flex flex-col gap-2">
          <div
            v-for="(w, i) in allWidgets" :key="w.key"
            class="flex items-center gap-1 rounded-lg border transition-colors"
            :class="isChosen(w) ? 'border-[var(--c-accent)] bg-[color-mix(in_srgb,var(--c-accent)_12%,transparent)]' : 'border-[var(--c-border)] bg-[var(--c-surface)]'"
          >
            <button
              :data-tv-pick-first="i === 0 ? '' : undefined"
              class="flex-1 flex items-center justify-between px-4 py-3 text-left outline-none rounded-lg focus:ring-2 focus:ring-[var(--c-accent)]"
              @click="toggleWidget(w)"
            >
              <span class="text-sm font-medium truncate">
                <span v-if="isChosen(w)" class="text-[var(--c-accent)] mr-1">{{ chosenIndex(w) + 1 }}.</span>{{ w.name }}
              </span>
              <span class="text-xs ml-2" :class="isChosen(w) ? 'text-[var(--c-accent)]' : 'text-[var(--c-muted)]'">{{ isChosen(w) ? '✓ ' + w.size : w.size }}</span>
            </button>
            <template v-if="isChosen(w)">
              <button class="w-9 h-9 shrink-0 rounded-md text-[var(--c-muted)] outline-none hover:text-[var(--c-fg)] focus:ring-2 focus:ring-[var(--c-accent)]" title="Move earlier" @click="moveWidget(w, -1)">↑</button>
              <button class="w-9 h-9 shrink-0 mr-1 rounded-md text-[var(--c-muted)] outline-none hover:text-[var(--c-fg)] focus:ring-2 focus:ring-[var(--c-accent)]" title="Move later" @click="moveWidget(w, 1)">↓</button>
            </template>
          </div>
          <div v-if="!allWidgets.length" class="text-center text-sm text-[var(--c-muted)] py-8">No widgets available.</div>
        </div>
    </div>

    <!-- summary (read/summarize result) -->
    <div v-if="summary" class="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-40" @click.self="summary = null">
      <div class="w-[820px] rounded-2xl border border-[var(--c-border)] bg-[var(--c-card)] p-8">
        <div class="text-3xl font-light mb-5">{{ summary.title }}<span class="text-[var(--c-accent)]">.</span></div>
        <ol class="space-y-3">
          <li v-for="(p, i) in summary.points" :key="i" class="flex gap-3 text-lg">
            <span class="text-[var(--c-accent)] font-semibold w-6 shrink-0">{{ i + 1 }}</span>
            <span>{{ p }}</span>
          </li>
        </ol>
        <div class="text-xs text-[var(--c-muted)] mt-6">BACK to dismiss · {{ selectedModel }}</div>
      </div>
    </div>

    <!-- theme picker -->
    <div v-if="themePickerOpen" class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-start justify-center pt-16 z-40" @click.self="themePickerOpen = false">
      <div class="w-[760px] max-h-[80vh] rounded-2xl border border-[var(--c-border)] bg-[var(--c-card)] p-5 overflow-auto">
        <div class="text-xs uppercase tracking-widest text-[var(--c-muted)] mb-3">Theme<span class="text-[var(--c-accent)]">.</span></div>
        <div class="grid grid-cols-3 gap-3">
          <button
            v-for="(t, i) in THEMES" :key="t.id"
            :data-tv-theme-first="i === 0 ? '' : undefined"
            class="flex items-center gap-3 px-4 py-3 rounded-xl border text-left outline-none transition-colors focus:ring-2 focus:ring-[var(--c-accent)]"
            :class="t.id === themeId ? 'border-[var(--c-accent)]' : 'border-[var(--c-border)]'"
            :style="{ background: t.colors.background, color: t.colors.foreground }"
            @click="selectTheme(t.id)"
          >
            <span class="w-5 h-5 rounded-full shrink-0" :style="{ background: t.colors.accent }"></span>
            <span class="text-sm font-medium truncate">{{ t.name }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- firing alert: a timer/alarm/reminder went off (visual + sound + voice) -->
    <div v-if="firing" class="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-8 bg-[color-mix(in_srgb,var(--c-accent)_20%,#000)] animate-pulse" @click="dismissFiring">
      <svg class="w-24 h-24 text-[var(--c-accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
      <div class="text-[clamp(48px,9vw,120px)] font-bold text-center px-10 leading-tight">{{ firing.title }}</div>
      <div class="text-lg text-[var(--c-muted)]">Press OK or BACK to dismiss</div>
    </div>

    <!-- toasts -->
    <div class="fixed bottom-6 right-6 flex flex-col gap-2 z-50">
      <div v-for="t in toasts" :key="t.id" class="px-4 py-2 rounded-lg text-sm font-medium border shadow-lg"
        :class="{
          'bg-green-500/10 text-green-500 border-green-500/30': t.kind==='success',
          'bg-red-500/10 text-red-500 border-red-500/30': t.kind==='error',
          'bg-amber-500/10 text-amber-500 border-amber-500/30': t.kind==='warning',
          'bg-[var(--c-surface)] text-[var(--c-fg)] border-[var(--c-border)]': t.kind==='info',
        }">{{ t.message }}</div>
    </div>
  </div>
</template>
