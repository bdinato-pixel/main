import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';

// A build stamp baked into the bundle so you can tell at a glance whether the
// PC is serving the latest code (compare with `git rev-parse --short HEAD`).
function buildId(): string {
  let sha = 'nogit';
  try {
    sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    // building outside a git checkout — fall back to the date alone
  }
  const date = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return `${sha} · ${date}`;
}

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8720',
      '/hook': 'http://localhost:8720',
      '/ws': { target: 'ws://localhost:8720', ws: true },
    },
  },
});
