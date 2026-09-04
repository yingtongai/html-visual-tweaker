import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: 'src/background/service-worker.ts',
        popup: 'src/popup/index.html',
        editor: 'src/content/editor.ts'
      },
      output: {
        entryFileNames: (chunk) => chunk.name === 'editor' ? 'content/editor.js' : 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  },
  publicDir: 'public'
});
