import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
const root = fileURLToPath(new URL('../', import.meta.url));
const definitions = JSON.parse(readFileSync(join(root, 'android/native-dependencies.json'), 'utf8')).dependencies;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// Upstream MIT notice, retained in every APK along with the bundled SLF4J notices.
const websocketLicense = `Copyright (c) 2010-2020 Nathan Rajlich

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.`;

export async function androidDependencies({ cache = join(root, '.runtime/android-native-deps') } = {}) {
  mkdirSync(cache, { recursive: true });
  const jars = [], licenses = [];
  for (const definition of definitions) {
    const { filename, url, sha256 } = definition;
    if (!/^[A-Za-z0-9.-]+\.jar$/.test(filename) || new URL(url).origin !== 'https://repo.maven.apache.org' || !/^[a-f0-9]{64}$/.test(sha256)) throw Error('Invalid native dependency manifest');
    const path = join(cache, filename);
    let bytes = existsSync(path) ? readFileSync(path) : null;
    if (bytes && sha(bytes) !== sha256) throw Error('Native dependency hash mismatch: ' + filename);
    if (!bytes) {
      console.log('Downloading verified Android dependency: ' + filename);
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw Error('Native dependency download failed: ' + filename);
      const chunks = []; let length = 0;
      for await (const chunk of response.body) { length += chunk.length; if (length > 5_000_000) throw Error('Native dependency size limit'); chunks.push(chunk); }
      bytes = Buffer.concat(chunks);
      if (sha(bytes) !== sha256) throw Error('Native dependency hash mismatch: ' + filename);
      writeFileSync(path, bytes);
    }
    const notice = definition.licenseEntry ? unzipSync(bytes)[definition.licenseEntry] : null;
    if (definition.licenseEntry && !notice) throw Error('Native dependency license missing');
    licenses.push(filename + '\n' + (notice ? Buffer.from(notice).toString('utf8') : websocketLicense));
    jars.push(path);
  }
  return { jars, licenses: licenses.join('\n\n') + '\n' };
}
