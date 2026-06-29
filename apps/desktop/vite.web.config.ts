import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Plain-Vite build of the React renderer for the headless "Creare Server" web
// runtime. This deliberately does NOT use electron-vite or electron — so the
// web UI can be built and served on machines where Electron can't be installed
// (corporate policy, proxy-blocked binary download). The renderer already uses
// zero Electron APIs (pure fetch + EventSource to the local API), so it builds
// and runs unchanged as a normal SPA. Output is served by Fastify from out/web.
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './', // relative asset URLs → served correctly from any origin/port
  plugins: [react()],
  resolve: {
    alias: { '@renderer': resolve(__dirname, 'src/renderer') },
  },
  build: {
    outDir: resolve(__dirname, 'out/web'),
    emptyOutDir: true,
  },
})
