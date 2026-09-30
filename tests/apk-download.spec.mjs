import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { SECURITY_HEADERS } from '../cloud/security.mjs';

// Isolated public download fixture; no accounts, credentials or install actions.
const payload = Buffer.from('synthetic-download-fixture\n'.repeat(100));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const release = { ...JSON.parse(readFileSync('android/published-release.json')), bytes: payload.length, sha256: sha(payload) };
const paths = ['apk.html', 'apk-download.css', 'apk-download.mjs', 'apk-conversations.svg', 'apk-chat.svg', 'apk-account.svg', 'brand-mark.svg', 'favicon.svg', 'style.css'];
const files = new Map(paths.map(name => ['/' + name, readFileSync('public/' + name)]));
const index = readFileSync('public/index.html', 'utf8').replace('<script type="module" src="/app.js"></script>', '');
let server, origin, manifest=release;
test.beforeAll(async () => {
  server=createServer((request,response) => {
    const path = new URL(request.url,'http://localhost').pathname;
    const send=(type,body,headers={}) => { response.writeHead(200, {...SECURITY_HEADERS,'Content-Type':type,...headers}); response.end(body); };
    if (path === '/downloads/android-manifest.json') return send('application/json', JSON.stringify(typeof manifest === 'function' ? manifest() : manifest));
    if (path === '/downloads/' + release.filename) return send('application/vnd.android.package-archive', payload, { 'Content-Disposition': `attachment; filename="${release.filename}"` });
    if (path === '/') return send('text/html',index);
    if (!files.has(path)) {response.writeHead(404);return response.end();}
    const contentType = path.endsWith('.css') ? 'text/css' : path.endsWith('.mjs') ? 'text/javascript' : path.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
    send(contentType, files.get(path));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r)); origin='http://127.0.0.1:'+server.address().port;
});
test.afterAll(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});

test('APK page renders on desktop and phone and downloads from the same server', async ({ page }) => {
  manifest=release;
  const errors=[]; page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin+'/apk.html');
  await expect(page.locator('#release-info')).toContainText(`v${release.version}`);
  const button = page.getByRole('link', { name: '下载 APK', exact: true });
  await expect(button).toHaveAttribute('href', '/downloads/' + release.filename);
  await expect(button).toHaveAttribute('download', release.filename);
  for (const viewport of [{width:1365,height:1000},{width:375,height:812},{width:320,height:740}]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for(const image of await page.locator('.preview-mat img').all()) {
      await image.scrollIntoViewIfNeeded();
      await expect.poll(() => image.evaluate(el => el.complete && el.naturalWidth > 0)).toBe(true);
    }
  }
  await button.scrollIntoViewIfNeeded();
  const downloading = page.waitForEvent('download'); await button.click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(release.filename);
  expect(sha(readFileSync(await download.path()))).toBe(release.sha256);
  expect(errors).toEqual([]);
  mkdirSync('test-results', {recursive:true});
  await page.setViewportSize({width:1365,height:1050}); await page.evaluate(() => scrollTo(0,0));
  await page.screenshot({path:'test-results/apk-download-desktop.png',fullPage:true});
  await page.setViewportSize({width:375,height:812}); await page.evaluate(() => scrollTo(0,0));
  await page.screenshot({path:'test-results/apk-download-mobile.png',fullPage:true});
});

test('invalid release cannot point downloads elsewhere and retry recovers', async ({ page }) => {
  let valid=false;
  manifest=() => valid ? release : {...release,filename:'https://elsewhere.test/application.apk'};
  await page.goto(origin+'/apk.html');
  await expect(page.locator('#release-info')).toContainText('请重试');
  await expect(page.locator('#download-apk')).not.toHaveAttribute('href');
  valid=true; await page.getByRole('button',{name:'重新读取'}).click();
  await expect(page.locator('#download-apk')).toHaveAttribute('href','/downloads/'+release.filename);
});

test('login, sidebar and mobile My all expose the APK page', async ({ page }) => {
  manifest=release; await page.goto(origin+'/');
  await page.evaluate(() => { document.getElementById('web-startup').hidden=true; document.getElementById('auth-screen').hidden=false; });
  await expect(page.locator('.auth-downloads').getByRole('link',{name:'APK 下载'})).toBeVisible();
  await expect(page.locator('.auth-downloads').getByRole('link',{name:'CLI 安装与使用'})).toBeVisible();
  await page.locator('.auth-downloads').getByRole('link',{name:'APK 下载'}).click();
  await expect(page).toHaveURL(origin+'/apk.html');
  await page.goBack();
  await page.evaluate(() => { document.getElementById('auth-screen').hidden=true; document.getElementById('chat-screen').hidden=false; });
  await expect(page.locator('.web-nav-bottom').getByRole('link',{name:'APK 下载'})).toBeVisible();
  await expect(page.locator('.web-nav-bottom')).not.toContainText('双人加密会话');
  await page.setViewportSize({width:375,height:812});
  await page.evaluate(() => { document.getElementById('chat-body').hidden=true; document.getElementById('my-panel').hidden=false; });
  await expect(page.locator('#my-panel').getByRole('link',{name:'APK 下载'})).toBeVisible();
});
