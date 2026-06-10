import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // `jose` (JWT) is ESM-only — externalizing it makes the CJS main bundle do a
    // require() that throws ERR_REQUIRE_ESM. Exclude it so it gets bundled instead.
    plugins: [externalizeDepsPlugin({ exclude: ['jose'] })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: { '@renderer': resolve(__dirname, 'src/renderer') },
    },
  },
})
