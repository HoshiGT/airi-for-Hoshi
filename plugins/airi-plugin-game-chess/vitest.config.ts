import { defineConfig } from 'vitest/config'

// Unit tests cover pure logic only (rules adapters, UCI parsing, the Airi
// move-selection bridge envelope). They run in Node without a DOM; the WASM
// engines and Vue components are exercised through the Electron e2e scenarios
// in `packages/scenarios-stage-tamagotchi-electron`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
