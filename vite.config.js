import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' = relativní cesty. Stránka pak funguje na adrese
// jmeno.github.io/nazev-repozitare/ i na vlastní doméně, bez úprav.
export default defineConfig({
  plugins: [react()],
  base: './',
});
