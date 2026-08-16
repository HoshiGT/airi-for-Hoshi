import Vue from '@vitejs/plugin-vue'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Vue() lets tests mount SFCs directly (e.g. ChatArea.test.ts imports
  // ChatArea.vue); without it .vue files cannot be transformed.
  plugins: [Vue()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
})
