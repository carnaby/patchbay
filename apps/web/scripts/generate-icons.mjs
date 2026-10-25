// Renders the PWA icons from SVG. Run with `pnpm --filter @patchbay/web icons` after changing the logo.
import { writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const mark = (bg, light, size = 32) => `
  <rect width="${size}" height="${size}" rx="${size / 4}" fill="${bg}"/>
  <circle cx="10" cy="11" r="3" fill="#ff5a1f"/>
  <circle cx="22" cy="11" r="3" fill="${light}"/>
  <circle cx="10" cy="21" r="3" fill="${light}"/>
  <circle cx="22" cy="21" r="3" fill="#3987e5"/>
  <path d="M10 11 C 16 11, 16 21, 22 21" stroke="#ff5a1f" stroke-width="2" fill="none" stroke-linecap="round"/>`;

// Regular icon: the rounded logo as is.
const regular = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${mark('#0b0b0b', '#fcfcfb')}</svg>`;
// Maskable icon: full-bleed background, artwork inside the 80% safe zone so any mask shape keeps it intact.
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" fill="#0b0b0b"/>
  <g transform="translate(6.4 6.4) scale(0.6)">${mark('#0b0b0b', '#fcfcfb')}</g></svg>`;

const render = (svg, size, file) => {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(new URL(`../public/icons/${file}`, import.meta.url), png);
};

render(regular, 192, 'icon-192.png');
render(regular, 512, 'icon-512.png');
render(maskable, 512, 'maskable-512.png');
render(maskable, 180, 'apple-touch-icon.png');
console.log('icons written to public/icons');
