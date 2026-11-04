// ── Реестр расширений Mornye (.sflx) и их установка ─────────────────────────
// Реестр: https://github.com/mornyeapp/Mornye-Extension (registry.json).
// Установка: скачать .sflx → сверить SHA-256 с реестром → распаковать в
// <providers>/<id>/ → дописать в manifest.json наш "runtime": "mornye".
// Источник с runtime mornye исполняет не наш provider.js, а index.js
// расширения через lib/sflx-bridge (child-процесс с curl-синхронными шимами).

const fs = require('fs');
const path = require('path');
const { extract, sha256 } = require('./zip');

const REGISTRY_URL = 'https://raw.githubusercontent.com/mornyeapp/Mornye-Extension/main/registry.json';
const REGISTRY_HOSTS = ['raw.githubusercontent.com', 'github.com'];
const FETCH_TIMEOUT_MS = 30_000;
const MAX_SFLX_BYTES = 24 * 1024 * 1024;

// строки реестра → плоский список расширений для UI
async function listRegistry(proxyArgs) {
  const raw = await fetchText(REGISTRY_URL, proxyArgs);
  const j = JSON.parse(raw);
  const arr = Array.isArray(j.extensions) ? j.extensions : [];
  const exts = [];
  for (const val of arr) {
    if (!val || typeof val !== 'object' || !val.download_url) continue;
    const url = String(val.download_url);
    const m = url.match(/\/extensions\/([\w.-]+)\.sflx$/);
    if (!m) continue;
    exts.push({
      id: String(val.id || m[1]),
      file: m[1],
      name: String(val.display_name || val.name || m[1]),
      version: String(val.version || ''),
      description: String(val.description || '').slice(0, 220),
      category: String(val.category || ''),
      lossless: !!(Array.isArray(val.tags) && val.tags.includes('lossless') || /lossless/i.test(String(val.description || ''))),
      downloads: Number(val.downloads || 0),
      url,
      sha256: String(val.sha256 || ''),
      minAppVersion: String(val.min_app_version || val.minAppVersion || ''),
    });
  }
  return exts;
}

// качаем и ставим .sflx в providersDir; возвращает манифест установленного
async function install(ext, providersDir, proxyArgs) {
  const buf = await fetchBinary(ext.url, proxyArgs);
  if (buf.length < 1000) throw new Error('файл слишком мал — не похоже на .sflx');
  if (buf.length > MAX_SFLX_BYTES) throw new Error('.sflx слишком велик');

  const tmpFile = path.join(providersDir, `.dl-${ext.file}.sflx`);
  fs.mkdirSync(providersDir, { recursive: true });
  fs.writeFileSync(tmpFile, buf);

  if (ext.sha256) {
    const got = sha256(tmpFile);
    if (got.toLowerCase() !== String(ext.sha256).toLowerCase()) {
      fs.rmSync(tmpFile, { force: true });
      throw new Error('SHA-256 не сошёлся с реестром — файл подменён, установка отменена');
    }
  }

  // id берём из манифеста ВНУТРИ архива (не из реестра) — он и есть источник
  const probeDir = path.join(providersDir, `.probe-${Date.now()}`);
  let files;
  try { files = extract(tmpFile, probeDir); }
  catch (e) { cleanup(tmpFile, probeDir); throw e; }
  const mfPath = path.join(probeDir, 'manifest.json');
  if (!fs.existsSync(mfPath)) { cleanup(tmpFile, probeDir); throw new Error('в .sflx нет manifest.json'); }
  let mf;
  try { mf = JSON.parse(fs.readFileSync(mfPath, 'utf8')); }
  catch { cleanup(tmpFile, probeDir); throw new Error('manifest.json в .sflx не парсится'); }
  const id = String(mf.name || ext.id || '').toLowerCase().replace(/[^\w-]/g, '');
  if (!/^[\w-]{2,32}$/.test(id)) { cleanup(tmpFile, probeDir); throw new Error('плохой id расширения: ' + mf.name); }
  if (!fs.existsSync(path.join(probeDir, String(mf.entry || 'index.js')))) {
    cleanup(tmpFile, probeDir); throw new Error('в .sflx нет entry-файла');
  }

  // наши права: сети даём ровно то, что расширение декларировало
  const ourPerms = Array.isArray(mf.permissions && mf.permissions.network) ? mf.permissions.network : [];
  const dest = path.join(providersDir, id);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(probeDir, dest);
  const mfOut = {
    id,
    name: String(mf.displayName || mf.name || id).slice(0, 60),
    version: String(mf.version || ext.version || '0.0.0'),
    runtime: 'mornye',
    entry: String(mf.entry || 'index.js'),
    permissions: ourPerms,
    origin: 'mornye-registry',
  };
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(mfOut, null, 2));
  // подстраховка: наш manifest.json затирает их, но исходник оставляем рядом
  if (mf !== null) {
    try { fs.writeFileSync(path.join(dest, 'manifest.mornye.json'), JSON.stringify(mf, null, 2)); } catch {}
  }
  fs.rmSync(tmpFile, { force: true });
  return mfOut;
}

// установка локального .sflx (кнопка «из файла») — без сверки с реестром
function installFromFile(file, providersDir) {
  const probeDir = path.join(providersDir, `.probe-${Date.now()}`);
  let files;
  try { files = extract(file, probeDir); }
  catch (e) { cleanup(null, probeDir); throw e; }
  const mfPath = path.join(probeDir, 'manifest.json');
  if (!fs.existsSync(mfPath)) { cleanup(null, probeDir); throw new Error('в .sflx нет manifest.json'); }
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  const id = String(mf.name || '').toLowerCase().replace(/[^\w-]/g, '');
  if (!/^[\w-]{2,32}$/.test(id)) { cleanup(null, probeDir); throw new Error('плохой id расширения'); }
  const dest = path.join(providersDir, id);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(probeDir, dest);
  const mfOut = {
    id,
    name: String(mf.displayName || mf.name || id).slice(0, 60),
    version: String(mf.version || '0.0.0'),
    runtime: 'mornye',
    entry: String(mf.entry || 'index.js'),
    permissions: Array.isArray(mf.permissions && mf.permissions.network) ? mf.permissions.network : [],
    origin: 'local-file',
  };
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(mfOut, null, 2));
  return mfOut;
}

// удаление установленного расширения
function remove(id, providersDir) {
  if (!/^[\w-]{2,32}$/.test(String(id))) throw new Error('плохой id');
  const dest = path.join(providersDir, String(id));
  const mfPath = path.join(dest, 'manifest.json');
  if (!fs.existsSync(mfPath)) throw new Error('источник не найден');
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  if (mf.runtime !== 'mornye') throw new Error('удалять можно только mornye-источники');
  fs.rmSync(dest, { recursive: true, force: true });
}

function cleanup(tmpFile, probeDir) {
  if (tmpFile) { try { fs.rmSync(tmpFile, { force: true }); } catch {} }
  if (probeDir) { try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch {} }
}

// сеть через системный curl (есть в Windows 10 1803+; в Git Bash свой)
// sync-мир: реестр/установка вызываются из ipcMain.handle — можно блокировать
function curlArgs(proxyArgs) {
  return [...(proxyArgs || []), '-sL', '--fail', '--max-time', String(Math.ceil(FETCH_TIMEOUT_MS / 1000))];
}

async function fetchText(url, proxyArgs) {
  const { execFileSync } = require('child_process');
  const out = execFileSync('curl', [...curlArgs(proxyArgs), url], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true,
  });
  if (!out) throw new Error('реестр не отвечает');
  return out;
}

async function fetchBinary(url, proxyArgs) {
  const { execFileSync } = require('child_process');
  const out = execFileSync('curl', [...curlArgs(proxyArgs), '-o', '-', url], {
    encoding: 'buffer', maxBuffer: MAX_SFLX_BYTES + 1024 * 1024, windowsHide: true,
  });
  if (!out || !out.length) throw new Error('не скачался: ' + url);
  return out;
}

module.exports = { listRegistry, install, installFromFile, remove, REGISTRY_URL };
