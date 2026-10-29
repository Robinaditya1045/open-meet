import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backend = process.env.MEET_BACKEND ?? 'http://localhost:8088'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5188,
    host: '0.0.0.0',
    allowedHosts: true,
    // The client always talks to its own origin; in development Vite forwards
    // the API and the signaling socket to the Go server.
    proxy: {
      '/api': { target: backend, ws: true },
      '/healthz': { target: backend },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes('node_modules')) {
            if (id.includes('@radix-ui')) return 'radix'
            if (id.includes('lucide-react')) return 'icons'
            return 'vendor'
          }
        },
      },
    },
  },
})
