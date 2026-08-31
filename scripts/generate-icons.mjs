/**
 * Renders the LocalCast mark to PNG at the sizes iOS and Android actually need.
 *
 * Why hand-rolled: iOS ignores SVG for `apple-touch-icon`, so real PNG bytes are required,
 * and no image library is installed (or wanted — this runs once and should not add a native
 * dependency to the tree). Node's zlib is enough to write a valid PNG, and the mark is three
 * shapes, so a 30-line rasteriser is cheaper than a toolchain.
 *
 * The mark is taken from the design canvas itself: a dark plate, a rounded rectangle outline
 * in the accent blue, and a play triangle.
 *
 *   node scripts/generate-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const BG = [0x0d, 0x0e, 0x12];
const ACCENT = [0x4d, 0xa3, 0xff];

/** 4×4 supersampling — enough to keep the triangle's diagonal clean at 180px. */
const SS = 4;

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** @param {Uint8Array} rgba packed RGBA, row-major */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  // Filter type 0 (None) per scanline. The images are tiny and flat; a smarter filter would
  // save bytes we do not care about.
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Signed distance to a rounded rectangle, centred at (cx,cy). Negative inside. */
function sdRoundRect(px, py, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(px - cx) - (halfW - r);
  const qy = Math.abs(py - cy) - (halfH - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function insideTriangle(px, py, a, b, c) {
  const sign = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const d1 = sign([px, py], a, b);
  const d2 = sign([px, py], b, c);
  const d3 = sign([px, py], c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/**
 * @param size        output edge length in pixels
 * @param padding     fraction of the edge kept clear of artwork. Maskable icons need a safe
 *                    zone because Android crops them to whatever shape the launcher wants.
 * @param plateRadius corner radius of the background plate, as a fraction of the edge. Use 0
 *                    for maskable icons: they must bleed to the edges so the launcher's own
 *                    mask decides the silhouette, and a pre-rounded plate would show gaps.
 * @param plateAlpha  0 drops the background entirely, leaving a transparent glyph. The
 *                    Windows tray sits on a taskbar whose colour the user chose, so a plate
 *                    there would show as a rectangle against it.
 * @param accent      overrides the mark colour, used for the inactive tray glyph.
 */
function render(size, { padding = 0.14, plateRadius = 0.22, plateAlpha = 1, accent = ACCENT } = {}) {
  const px = new Uint8Array(size * size * 4);
  const S = size;
  const inner = S * (1 - padding * 2);
  const cx = S / 2;
  const cy = S / 2;

  // The canvas draws the mark as a 40×26 screen on a 100×100 plate. That ratio is right for
  // a thumbnail sitting in a page, but an app icon is viewed at 60px on a home screen, so
  // the artwork is scaled up to fill its safe area instead of floating in the middle.
  const halfW = (inner * 66) / 100 / 2;
  const halfH = (inner * 43) / 100 / 2;
  const radius = (inner * 6.6) / 100;
  const stroke = Math.max(2, (inner * 4.2) / 100);

  const triA = [cx - halfW * 0.36, cy - halfH * 0.52];
  const triB = [cx + halfW * 0.44, cy];
  const triC = [cx - halfW * 0.36, cy + halfH * 0.52];

  const plateR = S * plateRadius;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;

          let sr = 0;
          let sg = 0;
          let sb = 0;
          let sa = 0;

          // plateRadius 0 gives a square that reaches every edge, which is what a maskable
          // icon needs; anything larger rounds the corners for the standalone icon.
          if (plateAlpha > 0 && (plateRadius === 0 || sdRoundRect(fx, fy, cx, cy, S / 2, S / 2, plateR) <= 0)) {
            [sr, sg, sb] = BG;
            sa = 255;
          }

          const dRect = sdRoundRect(fx, fy, cx, cy, halfW, halfH, radius);
          const onOutline = dRect <= 0 && dRect >= -stroke;
          if (onOutline || insideTriangle(fx, fy, triA, triB, triC)) {
            [sr, sg, sb] = accent;
            sa = 255;
          }

          r += sr;
          g += sg;
          b += sb;
          a += sa;
        }
      }
      const n = SS * SS;
      const i = (y * S + x) * 4;
      px[i] = Math.round(r / n);
      px[i + 1] = Math.round(g / n);
      px[i + 2] = Math.round(b / n);
      px[i + 3] = Math.round(a / n);
    }
  }
  return encodePng(S, S, px);
}

/** [outputDirectory, [filename, size, options][]] */
const bundles = [
  [
    join(ROOT, 'apps', 'pwa', 'public', 'icons'),
    [
      // iOS home screen. iOS ignores SVG here and does not honour transparency, so this one
      // is always plated.
      ['apple-touch-icon-180.png', 180, { padding: 0.12 }],
      ['icon-192.png', 192, { padding: 0.12 }],
      ['icon-512.png', 512, { padding: 0.12 }],
      // Maskable: full bleed, artwork inside the 40% safe circle.
      ['maskable-192.png', 192, { padding: 0.2, plateRadius: 0 }],
      ['maskable-512.png', 512, { padding: 0.2, plateRadius: 0 }],
      ['favicon-32.png', 32, { padding: 0.08 }],
    ],
  ],
  [
    join(ROOT, 'apps', 'desktop', 'assets', 'icons'),
    [
      // electron-builder rasterises the installer icon from the largest PNG.
      ['app-256.png', 256, { padding: 0.12 }],
      ['app-512.png', 512, { padding: 0.12 }],
      // The Windows tray sits on whatever colour the user's taskbar is, so the tray glyphs
      // are transparent-backed: plateAlpha 0 drops the plate and leaves only the mark.
      ['tray-16.png', 16, { padding: 0.02, plateAlpha: 0 }],
      ['tray-32.png', 32, { padding: 0.02, plateAlpha: 0 }],
      // Shown while the server is stopped: same glyph, muted so the tray reads as inactive
      // at a glance rather than needing a colour the user has to interpret.
      ['tray-16-off.png', 16, { padding: 0.02, plateAlpha: 0, accent: [0x6f, 0x75, 0x7f] }],
      ['tray-32-off.png', 32, { padding: 0.02, plateAlpha: 0, accent: [0x6f, 0x75, 0x7f] }],
    ],
  ],
  [
    join(ROOT, 'apps', 'desktop-client', 'assets', 'icons'),
    [
      ['app-256.png', 256, { padding: 0.12 }],
      ['app-512.png', 512, { padding: 0.12 }],
    ],
  ],
];

for (const [out, targets] of bundles) {
  mkdirSync(out, { recursive: true });
  for (const [name, size, opts] of targets) {
    const png = render(size, opts);
    writeFileSync(join(out, name), png);
    console.log(`${join(out, name).replace(ROOT, '.')}  ${size}×${size}  ${png.length} bytes`);
  }
}
