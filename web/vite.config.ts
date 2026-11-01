import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const shim = (name: string) => fileURLToPath(new URL(`./src/shims/${name}.ts`, import.meta.url));

// xfwd passes the browser's host on, so the API's same-origin check sees localhost:4320 as Vercel would see its own host.
const proxy = { '/api': { target: 'http://127.0.0.1:4321', changeOrigin: true, xfwd: true } };

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [react()],
  resolve: { alias: { 'node:crypto': shim('crypto'), 'node:net': shim('net'), 'node:dns/promises': shim('dns') } },
  server: { port: 4320, fs: { allow: ['..'] }, proxy },
  preview: { proxy },
  build: { outDir: 'dist', emptyOutDir: true },
});
