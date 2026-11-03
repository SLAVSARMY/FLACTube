// Диагностика #4: локальный FLAC-плеер (сервер + загрузка в страницу)
import { readFileSync } from 'node:fs';

const port = process.argv[2] || '9222';
const logFile = process.argv[3];

// порт мини-сервера из лога приложения
let libPort = null;
if (logFile) {
  try {
    const m = readFileSync(logFile, 'utf8').match(/\[library\] локальные треки: http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) libPort = m[1];
  } catch {}
}
console.log('LIB_PORT:', libPort);

// 1. сервер отдаёт файл?
if (libPort) {
  for (const range of [undefined, 'bytes=0-5']) {
    try {
      const res = await fetch(`http://127.0.0.1:${libPort}/audio/dQw4w9WgXcQ`, { headers: range ? { Range: range } : {} });
      const body = await res.text();
      console.log('SERVER:', res.status, res.headers.get('content-type'), JSON.stringify(body.slice(0, 30)), 'range:', res.headers.get('content-range'));
    } catch (e) { console.log('SERVER_FAIL:', e.message); }
  }
  const res404 = await fetch(`http://127.0.0.1:${libPort}/audio/XXXXXXXXXXX`);
  console.log('SERVER_404:', res404.status);
}

// 2. страница может загрузить локальный трек?
const res = await fetch(`http://127.0.0.1:${port}/json/list`);
const targets = await res.json();
const page = targets.find(t => t.type === 'page' && /music\.youtube\.com/.test(t.url));
if (!page) { console.log('NO_PAGE'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pend = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;

console.log('BRIDGE:', await evalJs('typeof window.ytmDesktop'));
if (libPort) {
  const load = await evalJs(`(async () => {
    try {
      const a = new Audio('http://127.0.0.1:${libPort}/audio/dQw4w9WgXcQ');
      a.preload = 'auto';
      const ok = await Promise.race([
        new Promise((r) => { a.oncanplay = () => r(true); a.onerror = () => r(false); a.load(); }),
        new Promise((r) => setTimeout(() => r('timeout'), 5000)),
      ]);
      return String(ok);
    } catch (e) { return 'EXC:' + e.message; }
  })()`);
  console.log('PAGE_AUDIO_LOAD:', load);
}
ws.close();
process.exit(0);
