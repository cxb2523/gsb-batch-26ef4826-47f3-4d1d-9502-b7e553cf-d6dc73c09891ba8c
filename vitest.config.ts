import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // The @ain1084/audio-frame-buffer package only declares a "module" entry without
    // "main" or "exports". Map it explicitly so Vite/Vitest can resolve it in tests.
    alias: {
      '@ain1084/audio-frame-buffer': '@ain1084/audio-frame-buffer/dist/index.js',
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
})
