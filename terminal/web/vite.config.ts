import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8720',
      '/hook': 'http://localhost:8720',
      '/ws': { target: 'ws://localhost:8720', ws: true },
    },
  },
});
