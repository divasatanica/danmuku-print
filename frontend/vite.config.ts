import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.PRINT_WEB_PORT ?? 5173),
    strictPort: true,
    cors: false,
    fs: {
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/data/**', '**/*.{sqlite,sqlite3,db}*'],
    },
    proxy: {
      '^/api/': {
        target: `http://127.0.0.1:${Number(process.env.PRINT_PORT ?? 8759)}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../dist/frontend',
    emptyOutDir: true,
    rolldownOptions: {
      output: { entryFileNames: 'app.js' },
    },
  },
});
