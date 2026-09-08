<script setup lang="ts">
import { ref, shallowRef, watch, onMounted } from 'vue'
import type { Component } from 'vue'
import { loadSpace, entryPage } from './loader'
import { setActiveSpace as pinSpace } from './host'

const props = defineProps<{ spaceId: string }>()

const page = shallowRef<Component | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const name = ref('')

async function open(id: string) {
  loading.value = true
  error.value = null
  page.value = null
  try {
    pinSpace(id)
    const space = await loadSpace(id)
    if (!space) { error.value = `Could not load “${id}”.`; return }
    name.value = space.manifest.name || id
    const comp = entryPage(space)
    if (!comp) { error.value = `“${id}” has no page to show.`; return }
    page.value = comp
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

onMounted(() => open(props.spaceId))
watch(() => props.spaceId, id => open(id))
</script>

<template>
  <div class="h-full w-full overflow-auto">
    <div v-if="loading" class="h-full flex items-center justify-center text-[var(--c-muted)]">
      <div class="text-center">
        <div class="text-2xl font-light animate-pulse">Loading {{ spaceId }}…</div>
      </div>
    </div>
    <div v-else-if="error" class="h-full flex items-center justify-center text-center px-10">
      <div>
        <div class="text-xl font-semibold text-[var(--c-accent)]">Space unavailable</div>
        <div class="text-sm text-[var(--c-muted)] mt-2 max-w-md">{{ error }}</div>
      </div>
    </div>
    <component v-else-if="page" :is="page" />
  </div>
</template>
