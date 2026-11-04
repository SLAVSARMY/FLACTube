// ── Раннер mornye-расширения (child-процесс) ────────────────────────────────
// Запускается как: electron.exe (ELECTRON_RUN_AS_NODE=1) sflx-runner.js <dir>
// Живёт по JSON-RPC в stdin/stdout: {"id":N,"fn":"...","args":[...]}.
// Расширение синхронное (их runtime — QuickJS), поэтому все шимы у нас
// синхронные: http.get — системный curl (spawnSync), storage — json-файл,
// file.download/downloadSegments — curl + склейка. Прогресс пишем в stdout
// строками {"progress":0.42} — хост читает их по ходу, не дожидаясь ответа.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
const mf = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const perms = Array.isArray(mf.permissions) ? mf.permissions : [];
const storageFile = path.join(dir, '.storage.json');
const CURL_MAX_SECS = '30';
const MAX_SEGMENTS = 10000;
const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;

function send(obj) { try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch {} }

const log = {
  info: (...a) => send({ log: ['info', a.map(String).join(' ')] }),
  debug: (...a) => send({ log: ['debug', a.map(String).join(' ')] }),
  warn: (...a) => send({ log: ['warn', a.map(String).join(' ')] }),
  error: (...a) => send({ log: ['error', a.map(String).join(' ')] }),
};

// «net:host» в их правах пишут как "soundcloud.com" или "*.sndcdn.com" —
// разрешаем точное совпадение или любой поддомен. Схема http/https.
function hostAllowed(url) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  return perms.some((p) => {
    const pat = String(p || '').toLowerCase().replace(/^\*\./, '');
    return host === pat || host.endsWith('.' + pat);
  });
}

function curl(url, headers, extra, binary) {
  // без --fail: их расширения сами разбирают 4xx-тела (retry-логика, JSON ошибок);
  // статус дописываем -w и парсим, TLS/сеть — через exit-код в error-ветке
  const args = ['-sL', '--max-time', CURL_MAX_SECS, '-w', '\n%{http_code}'];
  for (const [k, v] of Object.entries(headers || {})) args.push('-H', `${k}: ${v}`);
  if (extra) args.push(...extra);
  args.push(url);
  const r = spawnSync('curl', args, {
    encoding: binary ? 'buffer' : 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error) return { statusCode: 0, error: String(r.error.message || r.error), body: binary ? Buffer.alloc(0) : '' };
  const out = r.stdout || (binary ? Buffer.alloc(0) : '');
  // статус-код дописан последней строкой
  let statusCode = 0;
  if (!binary) {
    const nl = out.lastIndexOf('\n');
    statusCode = parseInt(out.slice(nl + 1).trim(), 10) || 0;
    return { statusCode, body: out.slice(0, nl) };
  }
  const nl = out.lastIndexOf(0x0a);
  statusCode = parseInt(out.slice(nl + 1).toString().trim(), 10) || 0;
  return { statusCode, body: out.slice(0, nl) };
}

const http = {
  get(url, headers) {
    if (!hostAllowed(url)) throw new Error('домен не разрешён manifest: ' + url);
    const r = curl(url, headers, null, false);
    if (r.error) return { statusCode: r.statusCode, error: r.error, body: '' };
    return { statusCode: r.statusCode, body: r.body, headers: {} };
  },
};

const storage = {
  get(key) {
    try { const j = JSON.parse(fs.readFileSync(storageFile, 'utf8')); return j[String(key)]; }
    catch { return null; }
  },
  set(key, value) {
    let j = {};
    try { j = JSON.parse(fs.readFileSync(storageFile, 'utf8')); } catch {}
    j[String(key)] = value;
    fs.writeFileSync(storageFile, JSON.stringify(j));
    return true;
  },
};

const file = {
  // качает URL в файл (их onProgress мы не дёргаем — curl молчит до конца)
  download(url, destPath, opts) {
    if (!hostAllowed(url)) throw new Error('домен не разрешён manifest: ' + url);
    const args = ['-sL', '--fail', '--max-time', '600', '-o', String(destPath)];
    for (const [k, v] of Object.entries((opts && opts.headers) || {})) args.push('-H', `${k}: ${v}`);
    args.push(url);
    const r = spawnSync('curl', args, { windowsHide: true });
    if (r.error || r.status !== 0) throw new Error('file.download: curl ' + (r.status || (r.error && r.error.message)));
    return true;
  },
  // HLS: качаем сегменты по очереди и склеиваем (их maxParallel игнорируем —
  // синхронный мир; потеря скорости не потеря надёжности)
  downloadSegments(segments, destPath, opts) {
    if (!Array.isArray(segments)) throw new Error('downloadSegments: segments не массив');
    if (segments.length > MAX_SEGMENTS) throw new Error('слишком много сегментов: ' + segments.length);
    const headers = (opts && opts.headers) || {};
    const parts = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const url = typeof seg === 'string' ? seg : (seg && (seg.url || seg.uri));
      if (!url) throw new Error('segment ' + i + ': нет url');
      if (!hostAllowed(url)) throw new Error('домен сегмента не разрешён: ' + url);
      const part = destPath + '.seg' + i;
      const args = ['-sL', '--fail', '--max-time', '120', '-o', part];
      for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
      args.push(url);
      const r = spawnSync('curl', args, { windowsHide: true });
      if (r.status !== 0 || !fs.existsSync(part)) {
        for (const p of parts) { try { fs.rmSync(p, { force: true }); } catch {} }
        throw new Error('segment ' + i + ': curl ' + r.status);
      }
      const st = fs.statSync(part);
      if (st.size > MAX_SEGMENT_BYTES) throw new Error('segment ' + i + ' слишком велик');
      parts.push(part);
      if (opts && typeof opts.onProgress === 'function') {
        try { opts.onProgress(st.size, 0, i + 1, segments.length); } catch {}
      }
    }
    const w = fs.openSync(destPath, 'w');
    try {
      for (const p of parts) {
        const chunk = fs.readFileSync(p);
        fs.writeSync(w, chunk);
        try { fs.rmSync(p, { force: true }); } catch {}
      }
    } finally { fs.closeSync(w); }
    return true;
  },
  delete(p) { try { fs.rmSync(String(p), { force: true }); } catch {} return true; },
};

// utils — хелперы их runtime. Реализуем по использованию во всех 12 расширениях
// (проверено grep'ом по registry): sleep, randomUserAgent, appUserAgent,
// appVersion, isDownloadCancelled, md5, sha256, base64Decode,
// getResolutionRemainingMs.
const crypto = require('crypto');
const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
];
const utils = {
  // настоящий синхронный сон: child однопоточен, Atomics.wait легален
  sleep(ms) {
    const n = Math.min(5000, Math.max(0, Number(ms) || 0));
    if (n > 0) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n); } catch {} }
    return true;
  },
  randomUserAgent() { return UAS[Math.floor(Math.random() * UAS.length)]; },
  appUserAgent() { return 'Mornye/5.3.0 (FLACTube compat)'; },
  appVersion() { return '5.3.0'; },
  isDownloadCancelled() { return false; }, // отмена у нас — kill child, до вызова не доходит
  md5(s) { return crypto.createHash('md5').update(String(s), 'utf8').digest('hex'); },
  sha256(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); },
  base64Decode(s) { return Buffer.from(String(s), 'base64').toString('utf8'); },
  getResolutionRemainingMs() { return 0; },
};

const sandbox = { log, http, storage, file, utils, console: log };
sandbox.globalThis = sandbox;
// веб-глобалы, которых vm-контекст не даёт (расширения зовут их напрямую):
// fetch — под нашими правами (hostAllowed), остальное — стандартные классы
sandbox.URL = URL;
sandbox.URLSearchParams = URLSearchParams;
sandbox.TextEncoder = TextEncoder;
sandbox.TextDecoder = TextDecoder;
sandbox.AbortController = AbortController;
sandbox.setTimeout = setTimeout;
sandbox.clearTimeout = clearTimeout;
sandbox.atob = (s) => Buffer.from(String(s), 'base64').toString('binary');
sandbox.btoa = (s) => Buffer.from(String(s), 'binary').toString('base64');
sandbox.fetch = async (url, opts = {}) => {
  if (!hostAllowed(String(url))) throw new Error('fetch: домен не разрешён manifest: ' + url);
  return fetch(String(url), {
    method: opts.method || 'GET',
    headers: opts.headers,
    body: opts.body,
    redirect: 'follow',
    signal: opts.signal,
  });
};
// их runtime регистрирует обработчики через глобал registerExtension({...}):
// сохраняем функции прямо в контекст — дальше runner дергает их по имени
sandbox.registerExtension = (obj) => {
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'function') sandbox[k] = v;
  }
};

// грузим их entry в vm-контексте этого процесса: сам процесс изолирован
// (падение расширения не роняет приложение), сеть и файлы идут только через шимы
const entryPath = path.join(dir, mf.entry || 'index.js');
const code = fs.readFileSync(entryPath, 'utf8');
const vm = require('vm');
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: entryPath, timeout: 15000 });

const fns = {};
for (const name of ['initialize', 'cleanup', 'customSearch', 'handleUrl', 'getTrack', 'getAlbum',
  'getArtist', 'getPlaylist', 'searchTracks', 'getRelatedTracks', 'enrichTrack',
  'checkAvailability', 'download', 'getDownloadUrl']) {
  if (typeof sandbox[name] === 'function') fns[name] = sandbox[name];
}
if (typeof fns.initialize === 'function') {
  try { fns.initialize({}); } catch (e) { log.warn('initialize: ' + e.message); }
}
send({ ready: true, fns: Object.keys(fns) });

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    const fn = fns[req.fn];
    if (!fn) { send({ id: req.id, ok: false, error: 'нет функции ' + req.fn }); continue; }
    try {
      const result = fn(...(req.args || []));
      send({ id: req.id, ok: true, result: result === undefined ? null : result });
    } catch (e) {
      send({ id: req.id, ok: false, error: (e && e.message) || String(e) });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
