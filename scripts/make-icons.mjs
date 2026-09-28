// Generate PWA icons by rasterizing sparkDash's "bolt" glyph into PNGs.
// Dependency-free: uses only Node's zlib, so it runs anywhere the build runs.
// Output: public/icons/{icon-any.svg,icon-192,icon-512,icon-maskable-192,icon-maskable-512,apple-touch-icon}
//
// The bolt is colored to match the DARK app theme (accent #58a6ff) with a soft
// radial glow on a blue-tinted dark gradient, so the installed-app / Android
// splash screen reads as premium and matches the UI instead of a flat lone glyph.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "icons");

// Bolt outline, traced from assets/bolt.svg (viewBox 0 0 24 24), closed polygon.
const BOLT = [
  [13, 2],
  [3, 14],
  [12, 14],
  [11, 22],
  [21, 10],
  [12, 10],
];

// Dark-theme palette (src/index.css [data-theme="dark"]).
const BG_TOP = [11, 15, 22]; // #0b0f16
const BG_BOT = [22, 29, 41]; // #161d29
const ACCENT = [88, 166, 255]; // #58a6ff  (dark-mode accent)

// Even-odd point-in-polygon test.
function insidePoly(px, py, poly) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < (xj - xi) * ((py - yi) / (yj - yi)) + xi) {
      hit = !hit;
    }
  }
  return hit;
}

// Fractional coverage of one pixel via an s×s subgrid (antialiasing).
function coverage(cx, cy, half, poly, s) {
  let inCount = 0;
  for (let a = 0; a < s; a++) {
    for (let b = 0; b < s; b++) {
      const sx = cx + (-half + (half * 2 * (a + 0.5)) / s);
      const sy = cy + (-half + (half * 2 * (b + 0.5)) / s);
      if (insidePoly(sx, sy, poly)) inCount++;
    }
  }
  return inCount / (s * s);
}

// Rounded-rect mask: 1 inside, 0 outside corner radius.
function roundedMask(x, y, n, radius) {
  const r = radius;
  const nearX = x < r || x > n - r;
  const nearY = y < r || y > n - r;
  if (!nearX || !nearY) return 1;
  const cx = x < n / 2 ? r : n - r;
  const cy = y < n / 2 ? r : n - r;
  return Math.hypot(x - cx, y - cy) <= r ? 1 : 0;
}

// Render one icon.
//  maskable: full-bleed square (platform applies its own mask), glyph in safe zone.
//  ox/oy:    optical nudge in design units (the bolt is left-heavy; shift right).
function render(size, { maskable, fit, corner = 0.22, glow = 0.3, ox = 0.4, oy = 0 }) {
  const SS = 3; // supersample factor
  const buf = Buffer.alloc(size * size * 4);

  const xs = BOLT.map((p) => p[0]);
  const ys = BOLT.map((p) => p[1]);
  const dw = Math.max(...xs) - Math.min(...xs);
  const dh = Math.max(...ys) - Math.min(...ys);
  const cx0 = (Math.max(...xs) + Math.min(...xs)) / 2 + ox;
  const cy0 = (Math.max(...ys) + Math.min(...ys)) / 2 + oy;
  const scale = (fit * size) / Math.max(dw, dh);

  const radius = maskable ? 0 : Math.round(size * corner);
  const glowR = size * 0.34;

  for (let y = 0; y < size; y++) {
    const ty = y / (size - 1);
    const r0 = BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * ty;
    const g0 = BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * ty;
    const b0 = BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * ty;
    for (let x = 0; x < size; x++) {
      const gx = (x - size / 2) / scale + cx0;
      const gy = (y - size / 2) / scale + cy0;
      const glyph = coverage(gx, gy, 0.5 / scale, BOLT, SS);

      // background: gradient + soft radial accent glow.
      const dist = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
      const gg = dist < glowR ? glow * Math.pow(1 - dist / glowR, 2) : 0;
      const br = r0 + ACCENT[0] * gg;
      const bg = g0 + ACCENT[1] * gg;
      const bb = b0 + ACCENT[2] * gg;

      // background alpha: rounded-rect (0 outside) or full-bleed (1).
      const bgA = maskable ? 1 : roundedMask(x, y, size, radius);

      // composite glyph over background.
      const a = glyph + bgA * (1 - glyph);
      const bgMix = a === 0 ? 0 : (bgA * (1 - glyph)) / a;
      const R = Math.min(255, Math.round(ACCENT[0] * (1 - bgMix) + br * bgMix));
      const G = Math.min(255, Math.round(ACCENT[1] * (1 - bgMix) + bg * bgMix));
      const B = Math.min(255, Math.round(ACCENT[2] * (1 - bgMix) + bb * bgMix));

      const o = (y * size + x) * 4;
      buf[o] = R;
      buf[o + 1] = G;
      buf[o + 2] = B;
      buf[o + 3] = Math.round(a * 255);
    }
  }
  return buf;
}

// ── PNG encode (8-bit RGBA, no interlace) ────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePNG(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
const jobs = [
  ["icon-192.png", render(192, { maskable: false, fit: 0.74 })],
  ["icon-512.png", render(512, { maskable: false, fit: 0.74 })],
  ["icon-maskable-192.png", render(192, { maskable: true, fit: 0.62, glow: 0.34 })],
  ["icon-maskable-512.png", render(512, { maskable: true, fit: 0.62, glow: 0.34 })],
  ["apple-touch-icon.png", render(180, { maskable: true, fit: 0.66, glow: 0.3 })],
];
for (const [name, rgba] of jobs) {
  const size = Math.round(Math.sqrt(rgba.length / 4));
  writeFileSync(join(OUT, name), encodePNG(rgba, size));
  console.log(`wrote public/icons/${name} (${size}x${size})`);
}

// Scalable "any" icon (SVG), derived from the same glyph + accent so a fresh
// clone's `prebuild` regenerates the complete set, not just the raster sizes.
const hex = (n) => n.toString(16).padStart(2, "0");
const accentHex = "#" + ACCENT.map(hex).join("");
writeFileSync(
  join(OUT, "icon-any.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">\n` +
    `  <rect width="512" height="512" rx="96" fill="#0d1117" />\n` +
    `  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" fill="${accentHex}" transform="translate(64 64) scale(16)" />\n` +
    `</svg>\n`,
);
console.log("wrote public/icons/icon-any.svg");
