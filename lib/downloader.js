const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const { lookupDeezer, downloadCover, losslessResolve } = require('./lossless');
const { CommunityClient } = require('./community');

// Порядок приоритета аудиопотоков: 258/256/141 — AAC до 320/256 kbps (когда
// YouTube их отдаёт), 251 — Opus ~160 kbps, 140 — AAC 128 kbps.
const QUALITY_CHAIN = '258/256/141/251/140/bestaudio/bestaudio*';

function safeName(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140) || 'track';
}

module.exports = class DownloadManager extends EventEmitter {
  constructor(binDir, outDir) {
    super();
    this.binDir = binDir;
    this.outDir = outDir;
    this.proxy = '';
    this.cookiesFile = '';
    this.tidalApi = '';
    this.jobs = [];
    this.seq = 0;
    this.active = 0;
    this.queue = [];
    this.maxActive = 2;
  }

  setProxy(p) { this.proxy = (p || '').trim(); }
  setCookiesFile(p) { this.cookiesFile = p || ''; }
  setTidalApi(p) { this.tidalApi = (p || '').trim(); }
  // community-клиент SpotiFLAC (дефолтный lossless-источник)
  setCommunity(client, openBrowser) {
    this.community = new CommunityClient(client, openBrowser);
  }

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
      lossless: false,
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
    if (['queued', 'downloading', 'converting', 'enriching'].includes(job.status)) {
      job.status = 'canceled';
      this.emit('changed');
    }
  }

  _pump() {
    while (this.active < this.maxActive && this.queue.length) {
      this._run(this.queue.shift());
    }
  }

  _ffmpeg() {
    const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const full = path.join(this.binDir, exe);
    return fs.existsSync(full) ? full : 'ffmpeg';
  }

  _setStage(job, stage) {
    job.status = stage;
    this.emit('changed');
  }

  _finish(job, finalFile) {
    job.status = 'done';
    job.percent = 100;
    job.file = finalFile;
    this.emit('done', job);
    this.emit('changed');
  }

  _fail(job, msg) {
    job.status = 'error';
    job.error = String(msg || 'ошибка').slice(0, 300);
    this.emit('failed', job);
    this.emit('changed');
  }

  async _run(job) {
    const exe = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    const full = path.join(this.binDir, exe);
    const bin = fs.existsSync(full) ? full : 'yt-dlp';
    const hasFfmpeg = this.hasBin('ffmpeg');

    // FLAC: скачиваем оригинальный поток, дальше обогащаем и конвертим сами
    const tmpBase = path.join(this.outDir, `.tmp-${job.videoId}-${job.id}`);
    const tmpPath = tmpBase + '.%(ext)s';

    const args = ['--newline', '--no-playlist', '--windows-filenames', '--trim-filenames', '140', '-N', '4'];
    if (this.proxy) args.push('--proxy', this.proxy);
    args.push(...this.cookieArgs());
    args.push('-f', QUALITY_CHAIN);
    args.push('-o', job.format === 'flac' ? tmpPath : path.join(this.outDir, '%(title)s [%(id)s].%(ext)s'));

    if (job.source === 'soundcloud') args.push(job.pageUrl);
    else args.push(`https://www.youtube.com/watch?v=${job.videoId}`);

    job.status = 'downloading';
    job.error = '';
    let errTail = '';
    const proc = spawn(bin, args, { windowsHide: true });
    job.proc = proc;

    proc.stdout.on('data', (d) => String(d).split(/\r?\n/).forEach((l) => l && this._line(job, l)));
    proc.stderr.on('data', (d) => { errTail = (errTail + d).slice(-1500); });
    proc.on('error', (err) => { errTail += String(err); });
    proc.on('close', async (code) => {
      this.active--;
      job.proc = null;
      if (job.status === 'canceled') { this._cleanup(tmpBase); this._pump(); return; }
      if (code !== 0) {
        this._cleanup(tmpBase);
        this._fail(job, errTail.trim().split(/\r?\n/).filter(Boolean).pop() || ('yt-dlp завершился с кодом ' + code));
        this._pump();
        return;
      }

      try {
        if (job.format === 'flac') {
          if (!hasFfmpeg) {
            this._fail(job, 'ffmpeg не найден — установите бинарники кнопкой в панели');
          } else {
            const orig = this._findTmp(tmpBase);
            if (!orig) { this._fail(job, 'скачанный файл не найден'); }
            else await this._enrichAndConvert(job, orig, tmpBase);
          }
        } else {
          // RAW: yt-dlp уже сохранил с метаданными
          const saved = this._findSaved(job.videoId);
          this._finish(job, saved || '');
        }
      } catch (e) {
        this._cleanup(tmpBase);
        this._fail(job, (e && e.message) || 'ошибка обработки');
      }
      this._pump();
    });
    this.emit('changed');
  }

  _findTmp(base) {
    for (const ext of ['opus', 'webm', 'm4a', 'mp4', 'ogg', 'mp3', 'flac', 'wav']) {
      const p = base + '.' + ext;
      if (fs.existsSync(p) && fs.statSync(p).size > 10000) return p;
    }
    return null;
  }

  _findSaved(id) {
    let files = [];
    try { files = fs.readdirSync(this.outDir); } catch {}
    const f = files.find((x) => x.endsWith(`[${id}].` ) || x.includes(`[${id}].`));
    return f ? path.join(this.outDir, f) : '';
  }

  _cleanup(base) {
    for (const ext of ['opus', 'webm', 'm4a', 'mp4', 'ogg', 'mp3', 'flac', 'wav', 'jpg', 'png']) {
      try { fs.rmSync(base + '.' + ext, { force: true }); } catch {}
    }
    try { fs.rmSync(base + '.ll.flac', { force: true }); } catch {}
    try { fs.rmSync(base + '.meta.txt', { force: true }); } catch {}
  }

  // SpotiFLAC-конвейер: Deezer-метаданные → (опц.) lossless-источник → FLAC с тегами
  async _enrichAndConvert(job, orig, tmpBase) {
    this._setStage(job, 'enriching');

    // 1) резолв метаданных (публичный Deezer)
    let meta = null;
    try { meta = await lookupDeezer(job.title, job.artist); } catch {}
    const title = safeName((meta && meta.title) || job.title);
    const artist = (meta && meta.artist) || job.artist || '';
    const isrc = (meta && meta.isrc) || '';

    // 2) lossless: (а) кастомный tidal-api, (б) community SpotiFLAC по ISRC
    //    Стратегия: сервер лежит → ОТМЕНА (никаких фейков);
    //    трека нет в lossless → YouTube-оригинал (как в SpotiFLAC)
    let losslessSrc = null;
    let serverDown = false;
    let notInLossless = false;
    if (this.tidalApi && isrc) {
      try {
        losslessSrc = await losslessResolve(this.tidalApi, isrc, 'LOSSLESS');
        if (losslessSrc) job.lossless = true;
      } catch { serverDown = true; }
      if (losslessSrc && losslessSrc.kind === 'url') {
        // прямая ссылка → качаем файл
        const llFile = tmpBase + '.ll.flac';
        try {
          const r = await fetch(losslessSrc.url, { signal: AbortSignal.timeout(120000) });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length < 100000) throw new Error('файл слишком мал');
          fs.writeFileSync(llFile, buf);
          losslessSrc.filePath = llFile;
          job.lossless = true;
        } catch { losslessSrc = null; serverDown = true; }
      }
    }
    if (!losslessSrc && !serverDown && isrc && this.community) {
      // дефолтный путь: community-серверы SpotiFLAC (нужна одноразовая верификация в браузере).
      // Перебираем все источники: один может отдать 401/кулдаун — это не повод
      // отменять загрузку, пока другие отвечают.
      let sawResponse = false; // хоть один источник жив (даже если ответил «нет трека»)
      let hardFails = 0;       // источники, умершие целиком (401/сеть/500/кулдаун)
      const sources = [
        ['tidal', (q) => this.community.tidal(isrc, q)],
        ['qobuz', (q) => this.community.qobuz(isrc, q)],
        ['amazon', (q) => this.community.amazon(isrc, q)],
      ];
      for (const [, fn] of sources) {
        for (const q of ['24', '16']) {
          try {
            const res = await fn(q);
            const llFile = tmpBase + '.ll.flac';
            const r = await fetch(res.url, { signal: AbortSignal.timeout(180000) });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const buf = Buffer.from(await r.arrayBuffer());
            if (buf.length < 100000) throw new Error('файл слишком мал');
            fs.writeFileSync(llFile, buf);
            losslessSrc = { filePath: llFile, quality: res.quality };
            job.lossless = true;
            sawResponse = true;
            break;
          } catch (e) {
            if (e.code === 'NOT_FOUND' || /не дал ссылку|404/i.test(e.message)) {
              sawResponse = true; // источник жив, но трека в нём нет
              continue;
            }
            if (/верификац/i.test(e.message)) {
              this.emit('notify', '🎧 Открой проверку в браузере для lossless-источника (один раз)');
              continue;
            }
            // 401/кулдаун/сеть/500 — источник недоступен, пробуем следующий
            hardFails++;
            break;
          }
        }
        if (losslessSrc) break;
      }
      // трек есть в каталогах, но ни один источник его не отдал → YouTube-оригинал;
      // отменяем только если ВСЁ умерло и ни один источник не ответил
      if (!losslessSrc && sawResponse) notInLossless = true;
      if (!losslessSrc && !sawResponse) serverDown = true;
    }
    if (!isrc) notInLossless = true; // нет ISRC — нечем искать в lossless

    if (!losslessSrc && serverDown) {
      this._cleanup(tmpBase);
      this._fail(job, 'lossless-серверы недоступны — скачивание отменено. Попробуй позже или проверь интернет/прокси');
      return;
    }

    // 3) обложка
    const cover = tmpBase + '.jpg';
    const haveCover = await downloadCover((meta && meta.cover) || '', cover);

    // 4) имя результата — Название [id].<ext>
    // FLAC-контейнер только для честного lossless; иначе — оригинальный кодек
    const origExt = (orig.match(/\.(\w+)$/) || [])[1] || 'm4a';
    const outExt = losslessSrc ? 'flac' : (origExt === 'webm' ? 'opus' : (origExt === 'mp4' ? 'm4a' : origExt));
    const finalName = `${title} [${job.videoId}].${outExt}`;
    const finalPath = path.join(this.outDir, finalName);
    if (fs.existsSync(finalPath)) {
      this._cleanup(tmpBase);
      this._finish(job, finalPath);
      return;
    }

    // 5) сборка: из lossless — copy (он уже FLAC); из потока — copy без перекодирования,
    //    теги и обложка прикладываются поверх (ffmpeg copy = ноль потерь и быстро)
    this._setStage(job, 'converting');
    const ff = this._ffmpeg();
    const metaTags = [
      '-metadata', 'title=' + ((meta && meta.title) || job.title),
      '-metadata', 'artist=' + artist,
      '-metadata', 'album=' + ((meta && meta.album) || ''),
      '-metadata', 'date=' + ((meta && meta.year) || ''),
      '-metadata', 'ISRC=' + isrc,
      '-metadata', 'comment=https://music.youtube.com/watch?v=' + job.videoId,
    ];
    if (meta && meta.trackNum) metaTags.push('-metadata', 'track=' + meta.trackNum + '/999');

    const buildArgs = () => {
      // ВСЕ -i сначала, опции выхода (-map/-c/metadata) после:
      // ffmpeg применяет опции к следующему -i, порядок «-map 0:a -i cover»
      // ломает открытие обложки («cannot be applied to input url»)
      const args = ['-y', '-hide_banner', '-loglevel', 'error'];
      if (losslessSrc && losslessSrc.kind === 'manifest') {
        args.push('-i', 'data:application/dash+xml;base64,' + losslessSrc.manifest);
        job.lossless = true;
      } else if (losslessSrc && losslessSrc.filePath) {
        args.push('-i', losslessSrc.filePath);
      } else {
        args.push('-i', orig);
      }
      if (haveCover) args.push('-i', cover);
      args.push('-map', '0:a');
      if (haveCover) {
        args.push('-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic', '-metadata:s:v', 'title=Album cover');
      }
      args.push('-c:a', 'copy');
      args.push(...metaTags, finalPath);
      return args;
    };

    let r = spawnSync(ff, buildArgs(), { encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024 });

    // запасной план 1: контейнер не принял attached_pic (opus/ogg) —
    // повторяем с обложкой как METADATA_BLOCK_PICTURE (стандарт для opus)
    const failed = r.status !== 0 || !fs.existsSync(finalPath) || fs.statSync(finalPath).size < 5000;
    if (failed && !losslessSrc && haveCover) {
      try {
        const img = fs.readFileSync(cover);
        const mime = 'image/jpeg';
        const pb = Buffer.alloc(4 + 4 + mime.length + 4 + 11 + 16 + 4 + img.length);
        let o = 0;
        pb.writeUInt32BE(3, o); o += 4;
        pb.writeUInt32BE(mime.length, o); o += 4;
        pb.write(mime, o); o += mime.length;
        pb.writeUInt32BE(11, o); o += 4;
        pb.write('Album cover', o); o += 11;
        pb.writeUInt32BE(0, o); o += 4;
        pb.writeUInt32BE(0, o); o += 4;
        pb.writeUInt32BE(24, o); o += 4;
        pb.writeUInt32BE(0, o); o += 4;
        pb.writeUInt32BE(img.length, o); o += 4;
        img.copy(pb, o);
        const metaFile = tmpBase + '.meta.txt';
        const tags = [
          ';FFMETADATA1',
          'title=' + ((meta && meta.title) || job.title),
          'artist=' + artist,
          'album=' + ((meta && meta.album) || ''),
          'date=' + ((meta && meta.year) || ''),
          'ISRC=' + isrc,
          'comment=https://music.youtube.com/watch?v=' + job.videoId,
          'METADATA_BLOCK_PICTURE=' + pb.toString('base64'),
        ].join('\n');
        fs.writeFileSync(metaFile, tags);
        const args2 = ['-y', '-hide_banner', '-loglevel', 'error', '-i', orig, '-f', 'ffmetadata', '-i', metaFile, '-map', '0:a', '-map_metadata', '1', '-c:a', 'copy', finalPath];
        r = spawnSync(ff, args2, { encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
        try { fs.rmSync(metaFile, { force: true }); } catch {}
      } catch {}
    }

    // запасной план 2: совсем без обложки, только теги
    const failed2 = r.status !== 0 || !fs.existsSync(finalPath) || fs.statSync(finalPath).size < 5000;
    if (failed2 && !losslessSrc) {
      const args3 = ['-y', '-hide_banner', '-loglevel', 'error', '-i', orig, '-map', '0:a', '-c:a', 'copy', ...metaTags, finalPath];
      r = spawnSync(ff, args3, { encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
    }

    this._cleanup(tmpBase);
    if (r.status !== 0 || !fs.existsSync(finalPath) || fs.statSync(finalPath).size < 5000) {
      this._fail(job, 'ffmpeg: ' + ((r.stderr || '').trim().split(/\r?\n/).pop() || 'ошибка сборки'));
      return;
    }
    job.title = (meta && meta.title) || job.title;
    job.container = outExt;
    this._finish(job, finalPath);
  }

  _line(job, line) {
    let m;
    const prevStatus = job.status;
    if ((m = line.match(/\[download\]\s+([\d.]+)%/))) {
      job.percent = Math.min(100, parseFloat(m[1]));
    } else if (line.startsWith('[ExtractAudio]')) {
      job.status = 'converting';
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
};
