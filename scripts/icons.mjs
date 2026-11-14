// Renders the AdVault icon PNGs (pure Node, no dependencies): blue rounded square + white dial.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };

function render(size) {
  const S = 4, N = size * S; // supersample
  const px = new Float32Array(size * size * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = (x + 0.5) / N * 32, v = (y + 0.5) / N * 32;
    // rounded rect 2..30, r=8
    const dx = Math.max(10 - u, 0, u - 22), dy = Math.max(10 - v, 0, v - 22);
    if (Math.hypot(dx, dy) > 8) continue;
    let col = [59, 130, 246];
    const d = Math.hypot(u - 16, v - 16);
    const ring = Math.abs(d - 7) < 1.3;
    const tick = (Math.abs(u - 16) < 1.2 && (Math.abs(v - 10.5) < 1.6 || Math.abs(v - 21.5) < 1.6)) || (Math.abs(v - 16) < 1.2 && (Math.abs(u - 10.5) < 1.6 || Math.abs(u - 21.5) < 1.6));
    if (ring || tick) col = [255, 255, 255];
    const i = (Math.floor(y / S) * size + Math.floor(x / S)) * 4;
    px[i] += col[0]; px[i + 1] += col[1]; px[i + 2] += col[2]; px[i + 3] += 255;
  }
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4, a = px[i + 3];
    const o = y * (size * 4 + 1) + 1 + x * 4;
    raw[o] = a ? px[i] / (a / 255) : 0; raw[o + 1] = a ? px[i + 1] / (a / 255) : 0; raw[o + 2] = a ? px[i + 2] / (a / 255) : 0; raw[o + 3] = a / (S * S);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
for (const s of [16, 32, 48, 128]) writeFileSync(`public/icons/icon${s}.png`, render(s));
console.log('icons written');
