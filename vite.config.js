import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { adresaWebu } from './scripts/adresa.mjs';

// Plná adresa webu je potřeba pro náhled při sdílení: Facebook a spol.
// u obrázku neberou relativní cestu. Viz scripts/adresa.mjs.
export default defineConfig({
  // base './' = relativní cesty, web funguje na podadrese i na vlastní doméně
  base: './',
  plugins: [
    react(),
    { name: 'adresa-webu', transformIndexHtml: (html) => html.replaceAll('__SITE_URL__', adresaWebu()) },
  ],
});
