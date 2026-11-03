// Смоук-тест редизайна: скриншоты верхней панели и панели загрузок через CDP
const port = process.argv[2] || '9223';
const outDir = process.argv[3] || '.';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const res = await fetch(`http://127.0.0.1:${port}/json/list`);
const targets = await res.json();

async function shot(t, name, openDrawer) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((r) => {
    const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send('Page.enable');
  if (openDrawer) {
    await send('Runtime.evaluate', { expression: 'window.ytmDesktop && window.ytmDesktop.toggleDrawer()' });
    await sleep(900);
  }
  // проверка, что инъекция жива и ошибки не сыплются
  const probe = (await send('Runtime.evaluate', {
    expression: `(() => ({
      drawer: !!document.getElementById('ytm-drawer'),
      fabs: !!document.getElementById('ytm-fabs'),
      icons: document.querySelectorAll('#ytm-drawer svg').length,
      tabs: document.querySelectorAll('.ytm-tab').length,
      err: window.__ytmErr || null,
    }))()`,
    returnByValue: true,
  })).result?.result?.value;
  console.log(name, 'probe:', JSON.stringify(probe));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(outDir, name), Buffer.from(shot.result.data, 'base64'));
  ws.close();
}

const ytm = targets.find((t) => t.type === 'page' && /music\.youtube\.com/.test(t.url));
const bar = targets.find((t) => t.type === 'page' && /topbar\.html/.test(t.url));
console.log('targets:', targets.map((t) => t.type + ' ' + t.url.slice(0, 60)));
if (bar) await shot(bar, 'shot-topbar.png');
if (ytm) {
  await shot(ytm, 'shot-ytm.png');
  await shot(ytm, 'shot-drawer.png', true);
}
if (!ytm) console.log('NO_YTM_PAGE');
process.exit(0);
