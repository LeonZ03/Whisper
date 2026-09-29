import { build } from 'esbuild';
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const assets = join(root, '.runtime/android-build/assets');
mkdirSync(assets, { recursive: true });
for (const name of ['index.html', 'style.css']) copyFileSync(join(root, 'android/web', name), join(assets, name));
copyFileSync(join(root, 'public/brand-mark.svg'), join(assets, 'brand-mark.svg'));
await build({ absWorkingDir: root, entryPoints: ['android/web/entry.mjs'], outfile: join(assets, 'app.js'), bundle: true,
  minify: true, platform: 'browser', format: 'esm', target: ['es2022'], sourcemap: false, legalComments: 'eof',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) } });
console.log('Android local client assets ready: v' + pkg.version);
