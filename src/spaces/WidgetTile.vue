<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { Card } from '@construct-space/ui'
import { getWidgetComponent } from './loader'
import { mountWidget, readThemeVars } from './widgetMount'
import { getToken } from './session'

const props = defineProps<{ spaceId: string; widgetId: string; sizeKey?: string; label?: string }>()

// Read-only scheduler bridge for widgets (timer/alarm). The scheduler lives at
// the gateway's /api/source/scheduler/* and is reachable through the TV's own
// /api/source proxy with the linked device's token. We map the wire shape
// (next_run_at) to what widgets expect (nextRunAt).
interface WireTask { id: string; enabled: boolean; next_run_at?: string; action: unknown }
async function listTasks(spaceId: string): Promise<Array<{ id: string; enabled: boolean; nextRunAt?: string; action: unknown }>> {
  try {
    const token = getToken()
    const r = await fetch(`/api/source/scheduler/tasks?owner_space=${encodeURIComponent(spaceId)}&enabled=true`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!r.ok) return []
    const data = await r.json() as { tasks?: WireTask[] }
    return (data.tasks || []).map(t => ({ id: t.id, enabled: t.enabled, nextRunAt: t.next_run_at, action: t.action }))
  } catch {
    return []
  }
}

const host = ref<HTMLElement | null>(null)
const error = ref<string | null>(null)
const loading = ref(true)
let cleanup: (() => void) | null = null

async function render() {
  cleanup?.(); cleanup = null
  error.value = null; loading.value = true
  const el = host.value
  if (!el) return
  el.innerHTML = ''
  try {
    const found = await getWidgetComponent(props.spaceId, props.widgetId, props.sizeKey)
    if (!found) { error.value = `${props.spaceId}/${props.widgetId} unavailable`; return }
    const api = {
      instanceId: `${props.spaceId}:${props.widgetId}`,
      theme: { mode: 'dark' as const, vars: readThemeVars() },
      space: { id: props.spaceId, name: props.label || props.spaceId, icon: '' },
      scheduler: { list: () => listTasks(props.spaceId) },
    }
    cleanup = mountWidget(el, found.component, api)
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

onMounted(render)
watch(() => [props.spaceId, props.widgetId, props.sizeKey], render)
onBeforeUnmount(() => cleanup?.())
</script>

<template>
  <Card class="relative h-full w-full overflow-hidden !p-0">
    <div ref="host" class="tv-tile h-full w-full"></div>
    <div v-if="loading" class="absolute inset-0 flex items-center justify-center text-[var(--c-muted)] text-sm animate-pulse">{{ label || spaceId }}…</div>
    <div v-else-if="error" class="absolute inset-0 flex items-center justify-center text-center px-3 text-xs text-[var(--c-muted)]">{{ error }}</div>
  </Card>
</template>
