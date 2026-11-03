// Мини-сервер: отдаёт скачанные треки странице (для локального FLAC-воспроизведения).
// Безопасность:
//  - слушает только 127.0.0.1 (не виден из сети);
//  - каждый запуск — новый секретный токен в пути (/TOKEN/audio/ID),
//    чтобы чужие сайты/процессы не могли читать файлы, перебирая порты;
//  - проверка Host-заголовка против DNS-rebinding.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class LibraryServer {
  constructor() {
    this.server = null;
    this.port = 0;
    this.dir = '';
    this.token = crypto.randomBytes(24).toString('hex');
    this.cache = new Map();
    this.cacheTime = 0;
  }

  start(dir) {
    this.dir = dir;
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      this.server = http.createServer((req, res) => {
        try { this.handle(req, res); } catch { try { res.writeHead(500); res.end(); } catch {} }
      });
      this.server.on('error', () => done(0));
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        done(this.port);
      });
      // не даём держать соединения дольше необходимого
      this.server.keepAliveTimeout = 5000;
    });
  }

  // Полный URL для трека (с токеном)
  url(id) {
    return `http://127.0.0.1:${this.port}/${this.token}/audio/${id}`;
  }

  setDir(d) {
    if (d !== this.dir) {
      this.dir = d;
      this.clearCache();
    }
  }

  clearCache() { this.cache.clear(); this.cacheTime = 0; }

  findFile(id) {
    const now = Date.now();
    if (now - this.cacheTime > 5000) {
      this.cache.clear();
      let files = [];
      try { files = fs.readdirSync(this.dir); } catch {}
      for (const f of files) {
        // только аудио: иначе обложка «Трек [ID].webp» затирает в кэше сам трек
        // с тем же ID, и сервер отдаёт картинку вместо музыки
        const m = f.match(/\[([\w-]{4,32})]\.(flac|m4a|mp3|opus|webm|ogg|wav|aac)$/i);
        if (m) this.cache.set(m[1], path.join(this.dir, f));
      }
      this.cacheTime = now;
    }
    return this.cache.get(id) || null;
  }

  handle(req, res) {
    // анти DNS-rebinding: Host обязан быть нашим локальным адресом
    const host = String(req.headers.host || '');
    if (host !== `127.0.0.1:${this.port}` && host !== 'localhost') {
      res.writeHead(403); res.end('forbidden'); return;
    }
    // только GET/HEAD
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405); res.end('method not allowed'); return;
    }

    const m = (req.url || '').match(/^\/([a-f0-9]{48})\/audio\/([\w-]{4,32})$/);
    if (!m) { res.writeHead(404); res.end('not found'); return; }
    if (m[1] !== this.token) { res.writeHead(401); res.end('unauthorized'); return; }
    const id = m[2];
    const file = this.findFile(id);
    if (!file) { res.writeHead(404); res.end('not found'); return; }

    let size = 0;
    try { size = fs.statSync(file).size; } catch { res.writeHead(404); res.end('not found'); return; }
    if (!size) { res.writeHead(500); res.end('empty'); return; }

    const type = /\.flac$/i.test(file) ? 'audio/flac'
      : /\.(opus|webm)$/i.test(file) ? 'audio/webm'
      : /\.mp3$/i.test(file) ? 'audio/mpeg'
      : 'audio/mp4';

    const range = req.headers.range;
    if (range) {
      const mm = range.match(/^bytes=(\d*)-(\d*)$/);
      let start = mm && mm[1] ? parseInt(mm[1], 10) : 0;
      let end = mm && mm[2] ? parseInt(mm[2], 10) : size - 1;
      if (!Number.isFinite(start) || start < 0) start = 0;
      if (!Number.isFinite(end) || end >= size) end = size - 1;
      if (start >= size || start > end) { res.writeHead(416); res.end(); return; }
      const headers = {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      };
      if (req.method === 'HEAD') { res.writeHead(206, headers); res.end(); return; }
      res.writeHead(206, headers);
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size };
      if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return; }
      res.writeHead(200, headers);
      fs.createReadStream(file).pipe(res);
    }
  }
}

module.exports = LibraryServer;
