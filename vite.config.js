import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths, so the built app works from any folder on a web
  // host (GitHub Pages serves it from /creatures/).
  base: './',
  worker: { format: 'es' },
});
