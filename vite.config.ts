/// <reference types="vitest/config" />
// The reference is a TYPE-only augmentation so `test` below is checked. It is
// deliberately not `import { defineConfig } from 'vitest/config'`, which would
// make a production `vite build` depend on a dev dependency resolving.
import { defineConfig } from 'vite';

// `base: './'` keeps every asset URL relative, so the built app runs from any
// static host at any nested subpath -- not just a domain root. See
// `npm run verify:subpath`, which enforces this.
export default defineConfig({
  base: './',
  build: {
    target: 'esnext',
    outDir: 'dist',
    assetsInlineLimit: 0,
    sourcemap: true,
  },
  worker: {
    // Phase 1 onwards generates world content in module workers.
    format: 'es',
  },
  server: {
    port: 5173,
  },
  preview: {
    port: 4173,
  },
  test: {
    /**
     * Vitest's 5 s default is too tight for the streaming tests, which drive a
     * synchronous fake worker through hundreds of REAL chunk generations --
     * ~1,200 height samples each -- inside one `it`. They were already within a
     * few seconds of the limit in Phase 2b and started timing out in Phase 3a
     * on a loaded container, which is a property of the machine rather than of
     * the code. A test that fails on a busy CI box teaches people to re-run
     * until green, which is worse than a slow suite.
     */
    testTimeout: 60000,
  },
});
