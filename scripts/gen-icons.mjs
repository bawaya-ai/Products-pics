import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

mkdirSync('public', { recursive: true });

const bag = (stroke = 26) => `
  <g fill="none" stroke="url(#gold)" stroke-width="${stroke}" stroke-linejoin="round" stroke-linecap="round">
    <path d="M148 196 h216 l-19 172 a26 26 0 0 1 -26 24 H193 a26 26 0 0 1 -26 -24 Z"/>
    <path d="M203 196 v-28 a53 53 0 0 1 106 0 v28"/>
  </g>`;

const defs = `
  <defs>
    <radialGradient id="bg" cx="50%" cy="28%" r="85%">
      <stop offset="0%" stop-color="#3a1016"/><stop offset="100%" stop-color="#0a0405"/>
    </radialGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ecd097"/><stop offset="100%" stop-color="#b8893f"/>
    </linearGradient>
  </defs>`;

// standard (rounded square)
const std = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${defs}
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>${bag()}</svg>`;

// maskable (full-bleed bg + icon inside the safe zone ~62%)
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${defs}
  <rect width="512" height="512" fill="url(#bg)"/>
  <g transform="translate(256 262) scale(0.66) translate(-256 -262)">${bag(30)}</g></svg>`;

const jobs = [
  ['public/icon-192.png', std, 192],
  ['public/icon-512.png', std, 512],
  ['public/icon-maskable-512.png', maskable, 512],
  ['public/apple-icon-180.png', std, 180],
  ['app/icon.png', std, 256],
  ['app/apple-icon.png', std, 180],
];
for (const [out, svg, size] of jobs) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(out);
  console.log('  ✓', out, size + 'px');
}
