const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');

// Порядок приоритета аудиопотоков: 258/256/141 — AAC до 320/256 kbps (когда
// YouTube их отдаёт), 251 — Opus ~160 kbps, 140 — AAC 128 kbps.
const QUALITY_CHAIN = '258/256/141/251/140/bestaudio/bestaudio*';

module.exports = class DownloadManager extends EventEmitter {
  constructor(binDir, outDir) {
    super();
    this.binDir = binDir;
    this.outDir = outDir;
    this.proxy = '';
    this.jobs = [];
    this.seq = 0;
    this.active = 0;
    this.queue = [];
    this.maxActive = 2;
  }

  setProxy(p) { this.proxy = (p || '').trim(); }
  setCookiesFile(p) { this.cookiesFile = p || ''; }

  cookieArgs() {
    if (this.cookiesFile && fs.existsSync(this.cookiesFile)) return ['--cookies', this.cookiesFile];
    return [];
  }

  hasBin(name) {
    const exe = process.platform === 'win32' ? `${name}.exe` : name;
    if (fs.existsSync(path.join(this.binDir, exe))) return true;
    const flag = name === 'yt-dlp' ? '--version' : '-version';
    try { return spawnSync(name, [flag], { stdio: 'ignore' }).status === 0; }
    catch { return false; }
  }

  list() { return this.jobs.map((j) => ({ ...j, proc: undefined })); }

  add(track, format) {
    const source = track.source === 'soundcloud' ? 'soundcloud' : 'youtube';
    const videoId = String(track.videoId || track.id || '');
    const job = {
      id: ++this.seq,
      videoId,
      source,
      pageUrl: track.pageUrl || '',
      title: track.title || videoId,
      artist: track.artist || '',
      format: format === 'copy' ? 'copy' : 'flac',
      status: 'queued',
      percent: 0,
      file: '',
      error: '',
    };
    const idOk = source === 'youtube'
      ? /^[\w-]{11}$/.test(videoId)
      : /^[\w-]{4,32}$/.test(videoId) && /^https?:\/\//.test(job.pageUrl);
    if (!idOk) {
      job.status = 'error';
      job.error = 'не найден ID трека — включи трек в плеере';
      this.jobs.unshift(job);
      this.emit('failed', job);
      this.emit('changed');
      return job;
    }
    this.jobs.unshift(job);
    this.queue.push(job);
    this.emit('added', job);
    this.emit('changed');
    this._pump();
    return job;
  }

  cancel(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return;
    if (job.proc) { try { job.proc.kill(); } catch {} }
    if (['queued', 'downloading', 'converting'].includes(job.status)) {
      job.status = 'canceled';
      this.emit('changed');
    }
  }

  // Поиск/импорт SoundCloud через yt-dlp: scsearch-запрос или прямая ссылка
  scQuery(arg) {
    return new Promise((resolve, reject) => {
      const exe = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
      const full = path.join(this.binDir, exe);
      const bin = fs.existsSync(full) ? full : 'yt-dlp';
      const args = ['--flat-playlist', '--dump-single-json', '--no-warnings'];
      if (this.proxy) args.push('--proxy', this.proxy);
      args.push(...this.cookieArgs());
      args.push(arg);
      let out = '';
      let err = '';
      const proc = spawn(bin, args, { windowsHide: true });
      proc.stdout.on('data', (d) => { out += d; });
      proc.stderr.on('data', (d) => { err = (err + d).slice(-800); });
      proc.on('error', (e) => reject(e));
      proc.on('close', (code) => {
        if (code !== 0) { reject(new Error(err.trim().split(/\r?\n/).filter(Boolean).pop() || ('код ' + code))); return; }
        try {
          const j = JSON.parse(out);
          const entries = (j.entries || []).map((e) => ({
            id: String(e.id || ''),
            title: e.title || 'SoundCloud',
            uploader: e.uploader || '',
            duration: Math.round(e.duration || 0),
            url: e.url || e.webpage_url || '',
          })).filter((e) => e.id && e.url);
          resolve(entries);
        } catch (e) {
          reject(new Error('не удалось разобрать ответ SoundCloud'));
        }
      });
    });
  }

  _pump() {
    while (this.active < this.maxActive && this.queue.length) {
      this._run(this.queue.shift());
    }
  }

  _run(job) {
    const exe = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    const full = path.join(this.binDir, exe);
    const bin = fs.existsSync(full) ? full : 'yt-dlp';
    const hasFfmpeg = this.hasBin('ffmpeg');

    if (job.format === 'flac' && !hasFfmpeg) {
      job.status = 'error';
      job.error = 'ffmpeg не найден — установите бинарники кнопкой в панели';
      this.emit('failed', job);
      this.emit('changed');
      return;
    }

    // [id] в имени — по нему локальный FLAC-плеер находит скачанные треки
    const tmpl = path.join(this.outDir, '%(title)s [%(id)s].%(ext)s');
    const args = ['--newline', '--no-playlist', '--windows-filenames', '--trim-filenames', '140', '-N', '4'];
    if (job.format === 'flac') {
      // Декодируем лучший аудиопоток и кодируем во FLAC без потерь.
      args.push('-f', QUALITY_CHAIN, '-x', '--audio-format', 'flac', '--audio-quality', '0',
        '--embed-metadata', '--embed-thumbnail', '--ffmpeg-location', this.binDir);
    } else {
      // Оригинальный поток без перекодирования (opus/m4a).
      args.push('-f', QUALITY_CHAIN);
      if (hasFfmpeg) args.push('--embed-metadata', '--ffmpeg-location', this.binDir);
    }
    if (this.proxy) args.push('--proxy', this.proxy);
    args.push(...this.cookieArgs());
    const url = job.source === 'soundcloud'
      ? job.pageUrl
      : `https://www.youtube.com/watch?v=${job.videoId}`;
    args.push('-o', tmpl, url);

    job.status = 'downloading';
    job.error = '';
    let errTail = '';
    const proc = spawn(bin, args, { windowsHide: true });
    job.proc = proc;

    proc.stdout.on('data', (d) => String(d).split(/\r?\n/).forEach((l) => l && this._line(job, l)));
    proc.stderr.on('data', (d) => { errTail = (errTail + d).slice(-1500); });
    proc.on('error', (err) => { errTail += String(err); });
    proc.on('close', (code) => {
      this.active--;
      job.proc = null;
      if (job.status !== 'canceled') {
        if (code === 0) {
          job.status = 'done';
          job.percent = 100;
          this.emit('done', job);
        } else {
          job.status = 'error';
          job.error = errTail.trim().split(/\r?\n/).filter(Boolean).pop() || ('yt-dlp завершился с кодом ' + code);
          this.emit('failed', job);
        }
      }
      this.emit('changed');
      this._pump();
    });
    this.emit('changed');
  }

  _line(job, line) {
    let m;
    const prevStatus = job.status;
    if ((m = line.match(/\[download\]\s+([\d.]+)%/))) {
      job.percent = Math.min(100, parseFloat(m[1]));
    } else if (line.startsWith('[download] Destination:')) {
      const mm = line.match(/Destination:\s*(.+)$/);
      if (mm) job.file = mm[1].trim();
    } else if (line.startsWith('[ExtractAudio]') || line.startsWith('[Merger]') || line.startsWith('[Metadata]')) {
      if (line.startsWith('[ExtractAudio]')) job.status = 'converting';
      const mm = line.match(/Destination:\s*(.+)$/);
      if (mm) job.file = mm[1].trim();
    }
    // не спамим событиями на каждую строку прогресса
    if (job.status !== prevStatus) {
      this.emit('changed');
    } else {
      const now = Date.now();
      if (now - (this._lastEmit || 0) > 300) {
        this._lastEmit = now;
        this.emit('changed');
      }
    }
  }
};
