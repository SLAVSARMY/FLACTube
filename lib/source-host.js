// ── Хост источников скачивания ──────────────────────────────────────────────
// Источник = папка с manifest.json + JS-резолвер, исполняемый в песочнице
// node:vm. Вшитые источники лежат в lib/sources, пользовательские — в
// <userData>/providers/<id>/. Контракт резолвера:
//   globalThis.resolve = async (ctx) => null
//     | { kind: 'command', url, formatChain? }   — URL для yt-dlp
//     | { kind: 'url', url, ext?, headers? }     — прямой аудиофайл
// null означает «источник не берётся за этот трек» — хост идёт к следующему.
// Песочница: никакого require/process/fs; сеть только через выданный fetch
// с белым списком доменов из manifest.permissions («net:host» = host и *.host).

const path = require('path');
const fs = require('fs');
const vm = require('vm');

const BUILTIN_DIR = path.join(__dirname, 'sources');
const ALLOWED_EXT = new Set(['flac', 'm4a', 'mp3', 'opus', 'ogg', 'wav', 'aac', 'webm']);
const RESOLVE_TIMEOUT_MS = 30_000;   // потолок одного resolve (поиск + ссылки)
const FETCH_TIMEOUT_MS = 15_000;     // потолок одного http-запроса из песочницы
const MAX_BODY_BYTES = 16 * 1024 * 1024; // JSON/страницы; аудио резолверы не качают
const MAX_ENTRIES = 50;              // потолок пользовательских источников

// https-only + белый список доменов. «net:host» покрывает host и *.host —
// CDN-ы обычно живут на поддоменах, а перечислять их все в manifest нельзя.
function hostAllowed(url, perms) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return perms.some((p) => {
    const h = String(p || '').toLowerCase();
    return host === h || host.endsWith('.' + h);
  });
}

// Результат резолвера проверяем на границе: песочнице верим только после этого.
function sanitizeResult(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.kind === 'command') {
    if (typeof r.url !== 'string' || !/^https:\/\//.test(r.url)) return null;
    return {
      kind: 'command',
      url: r.url,
      formatChain: typeof r.formatChain === 'string' && /^[\w/*+.,-]+$/.test(r.formatChain)
        ? r.formatChain : '',
    };
  }
  if (r.kind === 'url') {
    if (typeof r.url !== 'string' || !/^https:\/\//.test(r.url)) return null;
    const ext = String(r.ext || '').toLowerCase();
    if (ext && !ALLOWED_EXT.has(ext)) return null;
    const headers = {};
    if (r.headers && typeof r.headers === 'object') {
      for (const [k, v] of Object.entries(r.headers)) {
        if (/^[\w-]+$/.test(k) && /^[\w ;:.,()\/=-]*$/.test(String(v))) headers[k] = String(v);
      }
    }
    return { kind: 'url', url: r.url, ext: ext || '', headers };
  }
  return null;
}

module.exports = class SourceHost {
  // userDir — <userData>/providers; persist(order, disabled) — колбэк записи конфига
  constructor(userDir, persist, log) {
    this.userDir = userDir;
    this.persist = persist || (() => {});
    this.log = log || (() => {});
    this.sources = new Map(); // id → { id, name, version, builtin, perms, resolve, error }
    this.order = [];          // порядок опробования (id'ы, могут включать неизвестные)
    this.disabled = new Set();
  }

  async load(config) {
    this.order = Array.isArray(config && config.sourceOrder) ? config.sourceOrder.filter((x) => typeof x === 'string') : [];
    this.disabled = new Set(Array.isArray(config && config.sourceDisabled) ? config.sourceDisabled : []);

    const dirs = [];
    const scan = (root, builtin) => {
      let entries = [];
      try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
      for (const d of entries) {
        if (!d.isDirectory()) continue;
        if (dirs.length >= MAX_ENTRIES + 2) return;
        dirs.push({ dir: path.join(root, d.name), builtin });
      }
    };
    scan(BUILTIN_DIR, true);
    scan(this.userDir, false);

    for (const { dir, builtin } of dirs) {
      try {
        const s = this._loadOne(dir, builtin);
        if (s) this.sources.set(s.id, s);
      } catch (e) {
        this.log(`источник ${path.basename(dir)} не загружен: ${e.message}`);
      }
    }

    // порядок: конфиг → затем новые источники (вшитые вперёд пользовательских)
    const known = [...this.sources.keys()];
    const rest = known.filter((id) => !this.order.includes(id));
    const builtinRest = rest.filter((id) => this.sources.get(id).builtin);
    const userRest = rest.filter((id) => !this.sources.get(id).builtin);
    this.order = [...this.order.filter((id) => this.sources.has(id)), ...builtinRest, ...userRest];
    this.persist(this.order, [...this.disabled]);
  }

  _loadOne(dir, builtin) {
    const mfPath = path.join(dir, 'manifest.json');
    const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
    const id = String(mf.id || '').toLowerCase().replace(/[^\w-]/g, '');
    if (!/^[\w-]{2,32}$/.test(id)) throw new Error('manifest: плохой id');
    if (!builtin && (id === 'ytmusic' || id === 'soundcloud')) throw new Error('id занят вшитым источником');
    const perms = Array.isArray(mf.permissions)
      ? mf.permissions.map((p) => String(p).replace(/^net:/i, '').toLowerCase()).filter(Boolean)
      : [];
    const entryPath = path.join(dir, String(mf.entry || 'provider.js'));
    if (!/^[\\/\w.-]+\.js$/.test(path.basename(entryPath)) || !entryPath.startsWith(dir)) {
      throw new Error('manifest: плохой entry');
    }
    const code = fs.readFileSync(entryPath, 'utf8');
    if (code.length > 512 * 1024) throw new Error('entry слишком большой');

    const src = {
      id,
      name: String(mf.name || id).slice(0, 60),
      version: String(mf.version || '0.0.0').slice(0, 16),
      builtin: !!builtin,
      perms,
      resolve: null,
      error: '',
    };

    const sandbox = { globalThis: {} };
    sandbox.globalThis.fetch = async (url, opts = {}) => {
      if (!hostAllowed(String(url), perms)) throw new Error(`домен не разрешён manifest: ${url}`);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      try {
        const r = await fetch(String(url), {
          method: opts.method || 'GET',
          headers: opts.headers && typeof opts.headers === 'object' ? opts.headers : undefined,
          body: opts.body,
          redirect: 'follow',
          signal: ac.signal,
        });
        // текст с потолком размера: резолверам файлы не нужны, JSON — да
        const text = (await r.text()).slice(0, MAX_BODY_BYTES);
        return { ok: r.ok, status: r.status, text };
      } finally { clearTimeout(timer); }
    };
    sandbox.globalThis.log = (...a) => this.log(`[${id}]`, ...a);
    sandbox.console = { log: sandbox.globalThis.log, warn: sandbox.globalThis.log, error: sandbox.globalThis.log };
    sandbox.setTimeout = setTimeout;
    sandbox.clearTimeout = clearTimeout;
    sandbox.JSON = JSON;
    sandbox.URL = URL;
    sandbox.URLSearchParams = URLSearchParams;
    vm.createContext(sandbox);
    new vm.Script(code, { filename: path.join(dir, path.basename(entryPath)) })
      .runInContext(sandbox, { timeout: 5000 });

    const fn = sandbox.resolve || (sandbox.globalThis && sandbox.globalThis.resolve);
    if (typeof fn !== 'function') throw new Error('entry не выставил resolve()');
    src.resolve = fn;
    return src;
  }

  list() {
    const byOrder = this.order.map((id) => this.sources.get(id)).filter(Boolean);
    return byOrder.map((s) => ({
      id: s.id, name: s.name, version: s.version, builtin: s.builtin,
      enabled: !this.disabled.has(s.id), error: s.error,
    }));
  }

  setOrder(ids) {
    const known = new Set(this.sources.keys());
    const next = ids.filter((id) => known.has(id));
    for (const id of this.sources.keys()) if (!next.includes(id)) next.push(id);
    this.order = next;
    this.persist(this.order, [...this.disabled]);
    return this.list();
  }

  setEnabled(id, on) {
    if (!this.sources.has(id)) return this.list();
    if (on) this.disabled.delete(id); else this.disabled.add(id);
    this.persist(this.order, [...this.disabled]);
    return this.list();
  }

  // Перебор по приоритету до первого, кто взял трек. Ошибки источника не убивают
  // цепочку — логируются и считаются «не моё»: один мёртвый источник не отменяет
  // загрузку (урок lossless-перебора).
  async resolveChain(ctx) {
    for (const id of this.order) {
      const s = this.sources.get(id);
      if (!s || this.disabled.has(id)) continue;
      try {
        const res = await Promise.race([
          Promise.resolve(s.resolve({ ...ctx })).then((r) => sanitizeResult(r)),
          new Promise((_, rej) => setTimeout(() => rej(new Error('resolve timeout')), RESOLVE_TIMEOUT_MS)),
        ]);
        if (res) return { sourceId: s.id, ...res };
      } catch (e) {
        this.log(`[${id}] resolve не удался: ${e.message}`);
      }
    }
    return null;
  }
};
