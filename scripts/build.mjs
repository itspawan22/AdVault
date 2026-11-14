// Bundles every extension entry point with esbuild into dist/.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
cpSync('public', 'dist', { recursive: true });

const common = {
  bundle: true,
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  target: 'chrome116',
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
};

// Content scripts must be classic (non-module) scripts → IIFE.
const builds = [
  { ...common, entryPoints: { hook: 'src/inject/hook.ts', content: 'src/content/content.ts' }, outdir: 'dist', format: 'iife' },
  { ...common, entryPoints: { background: 'src/background/background.ts' }, outdir: 'dist', format: 'esm' },
  { ...common, entryPoints: { popup: 'src/popup/main.tsx', offscreen: 'src/offscreen/offscreen.ts' }, outdir: 'dist', format: 'esm' },
];

if (watch) {
  for (const b of builds) (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
