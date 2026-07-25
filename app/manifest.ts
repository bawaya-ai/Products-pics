import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Scraper Pro',
    short_name: 'Scraper Pro',
    description: 'رابط منتج → صور بدون خلفية بحجم موحّد وجودة عالية → متجرك',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0a0405',
    theme_color: '#0a0405',
    lang: 'ar',
    dir: 'rtl',
    categories: ['productivity', 'business', 'shopping'],
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
