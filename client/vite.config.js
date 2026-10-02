import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, /api, /uploads and the websocket are proxied to the Express server
// so the app works same-origin with zero CORS friction. In production set
// VITE_API_URL to the backend origin (and CLIENT_URL on the server to match).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/uploads': { target: 'http://localhost:4000', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:4000', ws: true, changeOrigin: true },
    },
  },
});
