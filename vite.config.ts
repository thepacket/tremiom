import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import mkcert from 'vite-plugin-mkcert';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const pkgVersion = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8')
).version as string;

// Quantiom-style auto-incrementing version tail: the git commit count is the
// "most minor" version segment (bumps on every commit), with the short SHA
// for an exact build reference. Displayed as v<pkg>.<commits> (<sha>).
function git(cmd: string, fallback: string): string {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return fallback;
  }
}
const gitCommits = git('git rev-list --count HEAD', '0');
const gitSha = git('git rev-parse --short HEAD', 'unknown');

// TREMIOM_HTTP=1 disables HTTPS dev server. Default is HTTPS via mkcert
// so secure-context APIs and PWA install match production.
const useHttp = process.env.TREMIOM_HTTP === '1';

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
    __GIT_COMMITS__: JSON.stringify(gitCommits),
    __GIT_SHA__: JSON.stringify(gitSha),
  },
  plugins: [
    ...(useHttp ? [] : [mkcert()]),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      devOptions: { enabled: false },
      manifest: {
        name: 'tremiom',
        short_name: 'tremiom',
        description: 'Real-time and historical seismic data viewer',
        theme_color: '#0d0d0d',
        background_color: '#0d0d0d',
        display: 'standalone',
        scope: '/',
        start_url: '/',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: { globPatterns: ['**/*.{js,css,html,svg,png,ico}'] },
    }),
  ],
  server: {
    host: true,
    ...(useHttp ? {} : { https: {} }),
    proxy: {
      // WebSocket bridge to the Node multiplexer (server.mjs).
      // In dev, run `node server.mjs` alongside `vite` on port 8080.
      '/ws': {
        target: 'http://localhost:8080',
        changeOrigin: false,
        ws: true,
      },
      // REST proxies for catalog feeds also live on the Node side so we
      // can cache + rate-limit centrally.
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: false,
      },
    },
  },
});
