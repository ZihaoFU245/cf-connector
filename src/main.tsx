import React from 'react';
import { createRoot } from 'react-dom/client';
import ConnectorApp from './ui/ConnectorApp';
import './styles.css';

async function registerSW() {
  if ('serviceWorker' in navigator) {
    try {
      const swUrl = new URL('./sw/proxy-sw.ts', import.meta.url);
      const reg = await navigator.serviceWorker.register(swUrl, { scope: '/', type: 'module' });
      await navigator.serviceWorker.ready;
      // Send config to SW (worker base URL)
      const workerBase = import.meta.env.VITE_WORKER_BASE as string | undefined;
      if (reg.active && workerBase) {
        reg.active.postMessage({ type: 'config', workerBase });
        reg.active.postMessage({ type: 'warmup' });
      } else if (workerBase) {
        navigator.serviceWorker.controller?.postMessage({ type: 'config', workerBase });
        navigator.serviceWorker.controller?.postMessage({ type: 'warmup' });
      }
    } catch (e) {
      console.warn('Service worker registration failed:', e);
    }
  }
}

registerSW();

const root = createRoot(document.getElementById('root')!);
root.render(<React.StrictMode><ConnectorApp /></React.StrictMode>);
