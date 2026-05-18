import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    // Tells Vite to leave the PDF.js worker alone during dev mode
    exclude: ['pdfjs-dist'] 
  }
});