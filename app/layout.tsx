import type { Metadata, Viewport } from 'next';
import './globals.css';
import PWA from '@/components/PWA';

export const metadata: Metadata = {
  title: 'Scraper Pro — استيراد منتجات بضغطة',
  description: 'رابط منتج → صور بدون خلفية بحجم موحّد وجودة عالية → متجرك',
  applicationName: 'Scraper Pro',
  appleWebApp: { capable: true, title: 'Scraper Pro', statusBarStyle: 'black-translucent' },
};

export const viewport: Viewport = {
  themeColor: '#0a0405',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body>
        {children}
        <PWA />
      </body>
    </html>
  );
}
