import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  build: { outDir: 'dist', emptyOutDir: true, cssCodeSplit: false },
  server: { port: 3030, proxy: { '/api': 'http://localhost:8087' } },
})
