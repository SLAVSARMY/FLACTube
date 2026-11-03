// Тест TRUE-lossless ветки: локальный http-сервер отдаёт настоящий 16-bit FLAC,
// подменяем им community.tidal() — конвейер должен собрать .flac с тегами и обложкой.
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawnSync } = require('child_process');
const DownloadManager = require('../lib/downloader');
const { probeInfo } = require('../lib/lossless');

const root = path.join(__dirname, '..');
const ff = path.join(root, 'bin', 'ffmpeg.exe');
const ffprobe = path.join(root, 'bin', 'ffprobe.exe');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-flac-ll-test-'));
const flacFile = path.join(outDir, 'real.flac');

// 30 секунд настоящего 16-bit/44.1kHz FLAC (синус) — как «отданный сервером» файл
let r = spawnSync(ff, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
  'sine=frequency=440:duration=30', '-ar', '44100', '-sample_fmt', 's16', flacFile], { encoding: 'utf8' });
if (r.status !== 0) { console.log('ffmpeg не собрал тестовый FLAC:', r.stderr); process.exit(1); }
console.log('тестовый FLAC:', (fs.statSync(flacFile).size / 1024).toFixed(0), 'КБ');

// локальный «lossless-сервер»
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'audio/flac' });
  fs.createReadStream(flacFile).pipe(res);
});
server.listen(0, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}/real.flac`;

  const dm = new DownloadManager(path.join(root, 'bin'), outDir);
  dm.setCommunity('unused', () => {}); // чтобы ветка community вообще вызывалась
  // подмена: tidal «находит» трек и отдаёт нашу локальную ссылку
  dm.community.tidal = async () => ({ url, quality: '24', lyric: '' });
  dm.on('done', (j) => {
    console.log('\n=== ГОТОВО ===');
    console.log('файл:', path.basename(j.file));
    console.log('lossless:', j.lossless, '| контейнер:', j.container);
    if (fs.existsSync(j.file)) {
      console.log('ffprobe:', JSON.stringify(probeInfo(ffprobe, j.file)));
      // теги проверяем отдельным вызовом
      const t = spawnSync(ffprobe, ['-v', 'error', '-show_format', '-print_format', 'json', j.file], { encoding: 'utf8' });
      const tags = JSON.parse(t.stdout).format.tags || {};
      console.log('теги:', JSON.stringify(tags));
    }
    server.close();
    fs.rmSync(outDir, { recursive: true, force: true });
    console.log('[TEST] временная папка удалена');
    process.exit(0);
  });
  dm.on('failed', (j) => { console.log('=== ПРОВАЛ ===', j.error); server.close(); process.exit(1); });
  dm.on('notify', (m) => console.log('[notify]', m));

  console.log('[TEST] имитируем lossless-источник:', url);
  dm.add({ videoId: 'dQw4w9WgXcQ', source: 'youtube', title: 'Never Gonna Give You Up', artist: 'Rick Astley' }, 'flac');
});
