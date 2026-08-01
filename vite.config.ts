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
});
