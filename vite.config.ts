import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Open Graph 的 og:url 與 og:image 必須是絕對網址；換自訂網域時只改這一個常數。
const siteOrigin = 'https://claude-tw-invite.mapleee723.workers.dev';

const injectSiteOrigin: Plugin = {
  name: 'inject-site-origin',
  transformIndexHtml: (html) => html.replaceAll('%SITE_ORIGIN%', siteOrigin),
};

export default defineConfig({
  plugins: [react(), injectSiteOrigin],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup/htmlDialogElement.ts'],
  },
});
