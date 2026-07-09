import { resolve } from 'node:path'

import Vue from '@vitejs/plugin-vue'
import Unocss from 'unocss/vite'

import { defineConfig } from 'vite'

const root = resolve(import.meta.dirname, 'src', 'ui')

// NOTICE:
// The board UI runs inside an extension-ui iframe served from a per-session path
// like `/_airi/extensions/<id>/sessions/<session>/ui/...`, so every asset URL must
// be relative (`base: './'`). The WASM engines are large and are copied into
// `public/engines` by `scripts/copy-engines.mjs` instead of being bundled.
export default defineConfig({
  root,
  base: './',
  publicDir: resolve(import.meta.dirname, 'public'),
  plugins: [
    Vue(),
    Unocss(),
  ],
  // Emscripten engine glue scripts are loaded at runtime from `public/engines`,
  // never imported, so they must stay out of dependency optimization.
  optimizeDeps: {
    exclude: ['stockfish', 'fairy-stockfish-nnue.wasm'],
  },
  build: {
    outDir: resolve(import.meta.dirname, 'dist', 'ui'),
    emptyOutDir: true,
    target: 'esnext',
    rollupOptions: {
      input: resolve(root, 'index.html'),
    },
  },
})
