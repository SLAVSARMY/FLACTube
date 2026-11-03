// Диагностика #5: грузится ли локальный трек внутри страницы
const port = process.argv[2] || '9222';
const logFile = process.argv[3];
import { readFileSync } from 'node:fs';

let libPort = null;
try {
  const m = readFileSync(logFile, 'utf8').match(/\[library\] локальные треки: http:\/\/127\.0\.0\.1:(\d+)/);
  if (m) libPort = m[1];
} catch {}
console.log('LIB_PORT:', libPort);

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

// 1) главный процесс жив? (invoke через контекст страницы невозможен, но bridge есть)
console.log('BRIDGE:', await evalJs('typeof window.ytmDesktop'));

// 2) грузится ли аудио с мини-сервера внутри страницы
if (libPort) {
  const load = await evalJs(`(async () => {
    try {
      const a = new Audio('http://127.0.0.1:${libPort}/audio/dQw4w9WgXcQ');
      a.preload = 'auto';
      const ok = await Promise.race([
        new Promise((r) => { a.oncanplay = () => r(true); a.onerror = (e) => r('error:' + (a.error && a.error.code)); a.load(); }),
        new Promise((r) => setTimeout(() => r('timeout'), 6000)),
      ]);
      return String(ok);
    } catch (e) { return 'EXC:' + e.message; }
  })()`);
  console.log('PAGE_AUDIO_LOAD:', load);

  // 3) fetch внутри страницы — чтобы увидеть тело/ошибку
  const f = await evalJs(`(async () => {
    try {
      const r = await Promise.race([
        fetch('http://127.0.0.1:${libPort}/audio/dQw4w9WgXcQ'),
        new Promise((r) => setTimeout(() => r('timeout'), 6000)),
      ]);
      if (r === 'timeout') return 'FETCH_TIMEOUT';
      const t = await r.text();
      return r.status + ' ' + JSON.stringify(t.slice(0, 30));
    } catch (e) { return 'FETCH_EXC:' + e.message; }
  })()`);
  console.log('PAGE_FETCH:', f);
}
ws.close();
process.exit(0);
