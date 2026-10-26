import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(new URL('../public/cli/',import.meta.url),{recursive:true});
for(const n of ['bootstrap.ps1','bootstrap.sh'])copyFileSync(new URL('../client-distribution/'+n,import.meta.url),new URL('../public/cli/'+n,import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
await build({ absWorkingDir: root, entryPoints: ['src/app.mjs'], outfile: 'public/app.js', bundle: true, minify: true,
  platform: 'browser', format: 'esm', target: ['es2022'], sourcemap: false, legalComments: 'eof', logLevel: 'info',
  define: { __APP_VERSION__: JSON.stringify(version) } });
console.log('Whisper browser bundle ready.');
