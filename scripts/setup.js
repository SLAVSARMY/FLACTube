#!/usr/bin/env node
// Скачивает yt-dlp и ffmpeg в папку bin/ проекта.
const path = require('path');
const { ensureBinaries } = require('../lib/binaries');

const dir = path.join(__dirname, '..', 'bin');
console.log('Скачиваю yt-dlp и ffmpeg (~100 МБ) в:', dir);

ensureBinaries(dir, console.log)
  .then(() => console.log('\nГотово! Запуск приложения: npm start'))
  .catch((e) => {
    console.error('\nОшибка:', e.message);
    console.error('Можно положить binaries вручную в bin/: yt-dlp.exe и ffmpeg.exe');
    process.exit(1);
  });
