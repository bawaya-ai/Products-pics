import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Scraper Pro — استيراد منتجات بضغطة',
  description: 'رابط منتج → صور بدون خلفية بحجم موحّد وجودة عالية → متجرك',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
