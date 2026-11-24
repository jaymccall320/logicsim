// Renders the app icon PNGs into public/ using headless Chrome.
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const page = await browser.newPage();
for (const size of [180, 192, 512]) {
  await page.setViewport({ width: size, height: size });
  await page.setContent(`<body style="margin:0"><svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect width="100" height="100" fill="#14161c"/>
  <path d="M14 38 H30 M14 62 H30 M78 50 H90" stroke="#4cc38a" stroke-width="5" stroke-linecap="round"/>
  <path d="M30 26 H52 A24 24 0 0 1 52 74 H30 Z" fill="#2b303d" stroke="#e6e8ee" stroke-width="4" stroke-linejoin="round"/>
  <circle cx="81" cy="50" r="5" fill="#2b303d" stroke="#e6e8ee" stroke-width="4"/>
  </svg></body>`);
  await page.screenshot({ path: `public/icon-${size}.png` });
}
await browser.close();
