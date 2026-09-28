// Generate PWA icons by rasterizing sparkDash's "bolt" glyph into PNGs.
// Dependency-free: uses only Node's zlib, so it runs anywhere the build runs.
// Output: public/icons/{icon-192,icon-512,icon-maskable-512,apple-touch-icon}.png
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "icons");

// Bolt outline, traced from assets/bolt.svg (viewBox 0 0 24 24), closed polygon.
// Coordinates in the 24-unit design space.
const BOLT = [
  [13, 2],
  [3, 14],
  [12, 14],
  [11, 22],
  [21, 10],
  [12, 10],
];

// Brand colors (match --color-base / --color-accent in src/index.css).
const BG_TOP = [13, 17, 23]; // #0d1117
const BG_BOT = [20, 25, 32]; // #141920
const ACCENT = [232, 168, 48]; // #e8a830

// Even-odd coverage of a point against the polygon, supersampled for AA.
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

// Fractional coverage of one pixel via an s×s subgrid.
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

// Rounded-rect mask: 1 inside, 0 outside corner radius (for non-maskable icons).
function roundedMask(x, y, n, radius) {
  const r = radius;
  const corners = [
    [r, r],
    [n - r, r],
    [r, n - r],
    [n - r, n - r],
  ];
  // Inside the central cross is always in; only near corners can be out.
  const nearX = x < r || x > n - r;
  const nearY = y < r || y > n - r;
  if (!nearX || !nearY) return 1;
  let cx = 0;
  let cy = 0;
  for (const [kx, ky] of corners) {
    if ((x < n / 2) === (kx < n / 2) && (y < n / 2) === (ky < n / 2)) {
      cx = kx;
      cy = ky;
      break;
    }
  }
  return Math.hypot(x - cx, y - cy) <= r ? 1 : 0;
}

// Render one icon. `fit` = fraction of canvas the glyph occupies.
// maskable=true → full-bleed square (platform applies its own mask), glyph shrunk
// into the inner ~60% safe zone. maskable=false → rounded corners.
function render(size, { maskable, corner = 0.22, fit }) {
  const SS = 3; // supersample factor for antialiasing
  const buf = Buffer.alloc(size * size * 4);
  const poly = BOLT.map(([bx, by]) => [bx, by]);
  // Map design space (0..24) to pixel space so the glyph's center sits at canvas
  // center and its bounding box fills `fit * size`.
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const dw = Math.max(...xs) - Math.min(...xs);
  const dh = Math.max(...ys) - Math.min(...ys);
  const cx0 = (Math.max(...xs) + Math.min(...xs)) / 2;
  const cy0 = (Math.max(...ys) + Math.min(...ys)) / 2;
  const scale = (fit * size) / Math.max(dw, dh);

  const radius = maskable ? 0 : Math.round(size * corner);

  for (let y = 0; y < size; y++) {
    const ty = y / (size - 1);
    const r0 = Math.round(BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * ty);
    const g0 = Math.round(BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * ty);
    const b0 = Math.round(BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * ty);
    for (let x = 0; x < size; x++) {
      const gx = (x - size / 2) / scale + cx0;
      const gy = (y - size / 2) / scale + cy0;
      const glyph = coverage(gx, gy, 0.5 / scale, poly, SS);

      // background alpha: rounded-rect (0 outside) or full-bleed (1).
      const bgA = maskable ? 1 : roundedMask(x, y, size, radius);

      // composite: glyph over background
      const a = glyph + bgA * (1 - glyph);
      const mixBg = a === 0 ? 0 : (bgA * (1 - glyph)) / (a || 1);
      const R = Math.round(ACCENT[0] * (1 - mixBg) + r0 * mixBg);
      const G = Math.round(ACCENT[1] * (1 - mixBg) + g0 * mixBg);
      const B = Math.round(ACCENT[2] * (1 - mixBg) + b0 * mixBg);

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
  // raw scanlines with filter byte 0 (None) per row
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
  ["icon-192.png", render(192, { maskable: false, fit: 0.72 })],
  ["icon-512.png", render(512, { maskable: false, fit: 0.72 })],
  ["icon-maskable-512.png", render(512, { maskable: true, fit: 0.6 })],
  ["apple-touch-icon.png", render(180, { maskable: true, fit: 0.66 })],
];
for (const [name, rgba] of jobs) {
  const size = Math.round(Math.sqrt(rgba.length / 4));
  writeFileSync(join(OUT, name), encodePNG(rgba, size));
  console.log(`wrote public/icons/${name} (${size}x${size})`);
}
