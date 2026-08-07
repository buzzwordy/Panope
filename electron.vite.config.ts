import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Entry points follow electron-vite's conventions:
//   main     -> src/main/index.ts
//   preload  -> src/preload/index.ts
//   renderer -> src/renderer/index.html
// Node dependencies (incl. the ESM-only @kubernetes/client-node) are
// externalized by default so they load from node_modules at runtime.
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    plugins: [react()]
  }
})
