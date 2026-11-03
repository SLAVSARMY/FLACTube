// E2E-тест FLAC-конвейера без Electron: yt-dlp → Deezer-мета → community lossless → ffmpeg.
// Запуск: node scripts/test-flac.js [videoId]
const path = require('path');
const fs = require('fs');
const os = require('os');
const DownloadManager = require('../lib/downloader');
const { probeInfo } = require('../lib/lossless');

const videoId = process.argv[2] || 'dQw4w9WgXcQ'; // Rick Astley — есть и в YT, и в Deezer/Tidal
const root = path.join(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-flac-test-'));
const sessionPath = path.join(process.env.APPDATA, 'FLACTube', 'community_session.json');

const dm = new DownloadManager(path.join(root, 'bin'), outDir);
dm.setCommunity(sessionPath, (url) => console.log('[TEST] нужен браузер для верификации:', url));
dm.on('changed', () => {
  const j = dm.jobs[0];
  if (!j) return;
  console.log(`[job ${j.id}] ${j.status} ${j.percent | 0}% lossless=${j.lossless} err=${j.error || '-'}`);
});
dm.on('notify', (m) => console.log('[notify]', m));
dm.on('done', (j) => {
  console.log('\n=== ГОТОВО ===');
  console.log('файл:', j.file);
  console.log('lossless:', j.lossless, '| контейнер:', j.container);
  if (j.file && fs.existsSync(j.file)) {
    const info = probeInfo(path.join(root, 'bin', 'ffprobe.exe'), j.file);
    console.log('ffprobe:', JSON.stringify(info));
    console.log('размер:', (fs.statSync(j.file).size / 1024 / 1024).toFixed(2), 'МБ');
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  console.log('[TEST] временная папка удалена');
  process.exit(0);
});
dm.on('failed', (j) => {
  console.log('\n=== ПРОВАЛ ===');
  console.log('ошибка:', j.error);
  fs.rmSync(outDir, { recursive: true, force: true });
  process.exit(1);
});

console.log('[TEST] видео:', videoId, '| outDir:', outDir);
dm.add({ videoId, source: 'youtube', title: 'Never Gonna Give You Up', artist: 'Rick Astley' }, 'flac');
setTimeout(() => { console.log('[TEST] таймаут 4 мин'); process.exit(2); }, 240000).unref();
