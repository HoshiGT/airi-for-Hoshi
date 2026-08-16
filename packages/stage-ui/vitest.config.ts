import { join } from 'node:path'
import { cwd } from 'node:process'

import Vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import Info from 'unplugin-info/vite'

import { playwright } from '@vitest/browser-playwright'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

export default defineConfig(({ mode }) => {
  return {
    root: import.meta.dirname,
    // ffish-module.test.ts imports ffish.wasm via `?inline`; Vite only applies
    // `?inline` to files listed in assetsInclude, and .wasm is not an asset by
    // default.
    assetsInclude: [
      '**/ffish-es6/**/*.wasm',
    ],
    plugins: [
      Info(),
    ],
    test: {
      projects: [
        {
          extends: true,
          // Vue() lets jsdom-environment tests mount SFCs (e.g. Board.test.ts);
          // the node project otherwise can't transform .vue files.
          plugins: [
            Vue(),
          ],
          test: {
            name: 'node',
            include: ['src/**/*.test.ts'],
            exclude: ['src/**/*.browser.test.ts'],
            env: loadEnv(mode, join(cwd(), 'packages', 'stage-ui'), ''),
            fileParallelism: false,
            hookTimeout: 20_000,
            maxWorkers: 1,
            testTimeout: 20_000,
          },
        },
        {
          extends: true,
          // Browser tests are the only place we can assert real layout, so they
          // need the real utility CSS. Without UnoCSS every `h-full`/`gap-2` is
          // an inert class name and any layout assertion passes vacuously.
          // Test files opt in with `import 'virtual:uno.css'`.
          plugins: [
            Vue(),
            UnoCSS(),
          ],
          test: {
            name: 'browser',
            include: ['**/*.browser.{spec,test}.ts'],
            exclude: ['**/node_modules/**'],
            browser: {
              enabled: true,
              provider: playwright(),
              instances: [
                { browser: 'chromium' },
              ],
            },
          },
        },
      ],
    },
  }
})
