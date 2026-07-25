'use client';

import { useEffect } from 'react';

// Registers the service worker (installability + offline shell). No UI.
export default function PWA() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);
  return null;
}
