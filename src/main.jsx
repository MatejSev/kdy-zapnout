import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './app.jsx';

ReactDOM.createRoot(document.getElementById('root')).render(<App />);

// Instalace do telefonu a fungování bez signálu. Jen na https (GitHub Pages)
// a při vývoji na localhostu; jinde to prohlížeče stejně nedovolí.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
