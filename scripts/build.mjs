import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
await build({ absWorkingDir: root, entryPoints: ['src/app.mjs'], outfile: 'public/app.js', bundle: true, minify: true,
  platform: 'browser', format: 'esm', target: ['es2022'], sourcemap: false, legalComments: 'eof', logLevel: 'info',
  define: { __APP_VERSION__: JSON.stringify(version) } });
console.log('Whisper browser bundle ready.');
