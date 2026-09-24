import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await build({ absWorkingDir: root, entryPoints: ['src/app.mjs'], outfile: 'public/app.js', bundle: true, minify: true,
  platform: 'browser', format: 'esm', target: ['es2022'], sourcemap: false, legalComments: 'eof', logLevel: 'info' });
console.log('Whisper browser bundle ready.');
