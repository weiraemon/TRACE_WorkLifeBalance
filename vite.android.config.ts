import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
export default defineConfig({
  root: 'apps/android/web',
  plugins: [
    react(),
    {
      name: 'android-license-notices',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'third-party-notices.txt',
          source: fs.readFileSync(new URL('./THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8'),
        });
      },
    },
  ],
  build: { outDir: '../../../.android-dist', emptyOutDir: true },
});
