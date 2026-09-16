import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// The production build is served by the API server from the same origin, so no
// CORS work is needed. In development the proxy forwards /api to the local server.
export default defineConfig({
  plugins: [react()],
  build: {
    // Output goes to the repo-root `dist/web`, which is where the server looks
    // for it in both runtime shapes (`scripts/build.mjs` cleans `dist/` before
    // esbuild runs, so Vite must NOT clean it again or it would delete the
    // freshly built server bundles).
    outDir: '../dist/web',
    emptyOutDir: false,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: false,
      },
    },
  },
  test: {
    // Node stays the default: the API/lib tests are pure Node code. Component
    // tests opt into a DOM per file with a `// @vitest-environment jsdom`
    // docblock, so a jsdom setup never slows down the Node-only tests.
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      // `text` for the terminal, `json-summary` for the root-level gate script
      // that reads `web/coverage/coverage-summary.json`.
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        // Test files are the instrument, not the subject: counting them would
        // let a large test suite inflate the very number it exists to prove.
        'src/**/*.test.{ts,tsx}',
        // Pure bootstrap: mounts <App/> into #root and imports the stylesheet.
        // It has no branching a test could meaningfully assert, and exercising
        // it would only prove that ReactDOM.createRoot renders.
        'src/main.tsx',
        // Types only. TypeScript erases this module, so it emits zero runtime
        // statements; it can never be "covered" by any test.
        'src/types/api.ts',
      ],
    },
  },
})
