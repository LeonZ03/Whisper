import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
// A faithful cell rendering of test-only ConPTY captures, not a hand-drawn UI mockup.
const escape = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const palettes = {
  dark: { bg: '#0c0c0c', fg: '#cccccc', ansi: ['#0c0c0c','#c50f1f','#13a10e','#c19c00','#0037da','#881798','#3a96dd','#cccccc','#767676','#e74856','#16c60c','#f9f1a5','#3b78ff','#b4009e','#61d6d6','#f2f2f2'] },
  light: { bg: '#fafafa', fg: '#242424', ansi: ['#242424','#b02030','#187529','#8a6500','#214daa','#7f267f','#007b83','#d0d0d0','#606060','#ba253b','#187529','#8a6500','#214daa','#7f267f','#007b83','#fafafa'] },
};
function color(spec, fallback, palette) {
  if (spec.mode === 'default') return fallback;
  if (spec.mode === 'rgb') return '#' + spec.value.toString(16).padStart(6, '0');
  const i = spec.value;
  if (i < 16) return palette.ansi[i];
  if (i >= 232) { const c = (8 + (i - 232) * 10).toString(16).padStart(2,'0'); return '#' + c.repeat(3); }
  const n = i - 16, cube = [0,95,135,175,215,255];
  return '#' + [Math.floor(n/36), Math.floor(n/6)%6, n%6].map((x) => cube[x].toString(16).padStart(2,'0')).join('');
}
function html(frame, name, palette) {
  const rows = frame.rows.map((row) => '<div class="row">' + row.map((c) => {
    let fg = color(c.fg,palette.fg,palette), bg = color(c.bg,palette.bg,palette);
    if (c.inverse) [fg,bg] = [bg,fg];
    return `<span style="width:${c.width}ch;color:${fg};background:${bg};font-weight:${c.bold ? 700 : 400}"><span style="opacity:${c.dim ? '.68' : 1}">${escape(c.text)}</span></span>`;
  }).join('') + '</div>').join('');
  return `<!doctype html><meta charset="utf-8"><title>${escape(name)}</title><style>body{margin:0;padding:24px;background:${palette.bg};color:${palette.fg};font:15px/24px Consolas,'Microsoft YaHei',monospace}.row{height:24px;white-space:pre}.row>span{display:inline-block;vertical-align:top}footer{margin-top:12px;opacity:.6;font:12px 'Microsoft YaHei',sans-serif}</style>${rows}<footer>真实 PowerShell / ConPTY 测试输出的单元格渲染；实际色调由你的终端主题决定。</footer>`;
}
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const kind of ['menu', 'chat', 'interaction']) {
    const frame = JSON.parse(readFileSync(kind === 'interaction' ? 'test-results/cli-interaction-help.json' : `test-results/cli-color-${kind}.json`, 'utf8'));
    for (const [name, palette] of Object.entries(palettes)) {
      const page = await browser.newPage({ viewport: { width: 1030, height: 920 }, deviceScaleFactor: 1 });
      const content = html(frame, `${kind} / ${name}`, palette);
      await page.setContent(content); await page.evaluate(() => document.fonts.ready);
      const box = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
      await page.setViewportSize(box);
      await page.screenshot({ path: `test-results/cli-color-${kind}-${name}.png`, fullPage: true });
      await page.close();
    }
  }
  console.log('Rendered terminal previews from actual test cell captures.');
} finally { await browser.close(); }
