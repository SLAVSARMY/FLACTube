const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const YT_DLP_URLS = {
  win32: ['https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'],
  darwin: ['https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos'],
  linux: ['https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp'],
};

const FFMPEG_URLS = {
  win32: [
    'https://github.com/GyanD/codects/releases/latest/download/ffmpeg-release-essentials.zip',
    'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip',
  ],
};

function hasWorking(binPath, flag = '-version') {
  try {
    const r = spawnSync(binPath, [flag], { stdio: 'ignore' });
    return !r.error && r.status === 0;
  } catch { return false; }
}

async function downloadTo(url, dest, onProgress, minBytes = 1) {
  onProgress(`⤓ ${path.basename(url)} — соединение…`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} от ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  // содержимое только с ожидаемых хостов (защита от редиректа на левый контент)
  const h = new URL(res.url || url).hostname;
  if (!/(^|\.)githubusercontent\.com$|(^|\.)github\.com$/.test(h)) {
    throw new Error('неожиданный источник файла: ' + h);
  }
  const out = fs.createWriteStream(dest);
  let done = 0;
  let last = -1;
  const reader = res.body.getReader();
  for (;;) {
    const { value, done: fin } = await reader.read();
    if (fin) break;
    done += value.byteLength;
    out.write(Buffer.from(value));
    if (total) {
      const pct = Math.floor((done / total) * 100);
      if (pct !== last) {
        last = pct;
        onProgress(`⤓ ${path.basename(url)}: ${pct}% (${(done / 1048576).toFixed(1)} МБ)`);
      }
    }
  }
  await new Promise((r) => out.end(r));
  // sanity: битая html-страница вместо бинарника не пройдёт по размеру
  if (done < minBytes) {
    try { fs.rmSync(dest, { force: true }); } catch {}
    throw new Error(`файл подозрительно мал (${done} Б) — не сохраняю`);
  }
}

function walkFind(dir, name, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFind(p, name, out);
    else if (e.name === name) out.push(p);
  }
  return out;
}

function extractFfmpeg(zipPath, binDir, onProgress) {
  onProgress('Распаковка ffmpeg…');
  const tmp = fs.mkdtempSync(path.join(binDir, 'ffmpeg-tmp-'));
  const isWin = process.platform === 'win32';
  const cmd = isWin
    ? `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${tmp}" -Force`
    : `unzip -o "${zipPath}" -d "${tmp}"`;
  const r = isWin
    ? spawnSync('powershell', ['-NoProfile', '-Command', cmd], { stdio: 'ignore' })
    : spawnSync('sh', ['-c', cmd], { stdio: 'ignore' });
  if (r.status !== 0) throw new Error('Не удалось распаковать архив ffmpeg');

  const exe = isWin ? '.exe' : '';
  const ff = walkFind(tmp, `ffmpeg${exe}`)[0];
  if (!ff) throw new Error('ffmpeg не найден в архиве');
  fs.copyFileSync(ff, path.join(binDir, `ffmpeg${exe}`));
  const fp = walkFind(tmp, `ffprobe${exe}`)[0];
  if (fp) fs.copyFileSync(fp, path.join(binDir, `ffprobe${exe}`));
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function ensureBinaries(binDir, onProgress = () => {}) {
  fs.mkdirSync(binDir, { recursive: true });
  if (typeof fetch !== 'function') throw new Error('Нужен Node.js 18+');
  const isWin = process.platform === 'win32';
  const exe = isWin ? '.exe' : '';
  const installed = [];

  if (!hasWorking(path.join(binDir, `yt-dlp${exe}`), '--version') && !hasWorking('yt-dlp', '--version')) {
    const url = (YT_DLP_URLS[process.platform] || [])[0];
    if (!url) throw new Error('Нет ссылки yt-dlp для ' + process.platform);
    await downloadTo(url, path.join(binDir, `yt-dlp${exe}`), onProgress, 5 * 1024 * 1024);
    installed.push('yt-dlp');
  }

  if (!hasWorking(path.join(binDir, `ffmpeg${exe}`), '-version') && !hasWorking('ffmpeg', '-version')) {
    const urls = FFMPEG_URLS[process.platform] || [];
    if (!urls.length) throw new Error('Авто-установка ffmpeg поддержана только на Windows; поставьте его в PATH');
    let ok = false;
    let lastErr = null;
    for (const url of urls) {
      try {
        const zip = path.join(binDir, 'ffmpeg-download.zip');
        await downloadTo(url, zip, onProgress, 20 * 1024 * 1024);
        extractFfmpeg(zip, binDir, onProgress);
        fs.rmSync(zip, { force: true });
        ok = true;
        break;
      } catch (e) { lastErr = e; }
    }
    if (!ok) throw new Error('ffmpeg скачать не удалось: ' + (lastErr && lastErr.message));
    installed.push('ffmpeg');
  }

  onProgress(installed.length ? `Установлено: ${installed.join(', ')}` : 'Всё уже установлено');
  return installed;
}

module.exports = { ensureBinaries, hasWorking };
