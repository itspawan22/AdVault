// Zips dist/ into advault-extension-v<version>.zip (for the Chrome Web Store or sharing).
import JSZip from 'jszip';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
const zip = new JSZip();
const walk = (d) => readdirSync(d).forEach((f) => { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : zip.file(relative('dist', p).split(sep).join('/'), readFileSync(p)); });
walk('dist');
const { version } = JSON.parse(readFileSync('dist/manifest.json', 'utf8'));
const out = `advault-extension-v${version}.zip`;
writeFileSync(out, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log('wrote', out);
