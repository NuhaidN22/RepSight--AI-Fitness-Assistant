import { defineConfig } from 'vite';

// Forward /api calls to the FastAPI backend, so the frontend keeps using
// relative URLs like fetch('/api/sets') and no CORS setup is needed.
export default defineConfig({
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8080', // the local backend: uvicorn main:app --port 8080
    },
  },
});
