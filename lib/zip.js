// ── Мини-распаковщик zip (для .sflx-расширений Mornye) ──────────────────────
// Без зависимостей: читаю центральный каталог, инфлейчу zlib.inflateRaw.
// Поддержка: deflate (метод 8) и store (0). Этого достаточно для .sflx —
// они собираются стандартным zip (PK\x03\x04, deflate).
// Ограничения по безопасности: суммарный потолок распаковки, запрет путей
// с .. и абсолютных (zip-slip), только обычные файлы (каталоги создаём по путям).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAX_ENTRIES = 200;
const MAX_TOTAL_UNCOMPRESSED = 32 * 1024 * 1024;
const MAX_ENTRY_UNCOMPRESSED = 16 * 1024 * 1024;

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

function safeJoin(destDir, relName) {
  const norm = String(relName).replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) throw new Error('zip: абсолютный путь: ' + relName);
  const parts = norm.split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) throw new Error('zip: путь наружу: ' + relName);
  return path.join(destDir, ...parts);
}

// → [{ name, size }] распакованных файлов
function extract(zipPath, destDir) {
  const buf = fs.readFileSync(zipPath);
  if (buf.length < 22 || u32(buf, 0) !== 0x04034b50) throw new Error('zip: это не zip-архив');

  // центральный каталог ищем с хвоста по сигнатуре EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (u32(buf, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: нет конца каталога');

  const count = u16(buf, eocd + 10);
  const cdOff = u32(buf, eocd + 16);
  if (count > MAX_ENTRIES) throw new Error('zip: слишком много записей');

  const out = [];
  let total = 0;
  let o = cdOff;
  for (let n = 0; n < count; n++, o += 46 + u16(buf, o + 28) + u16(buf, o + 30) + u16(buf, o + 32)) {
    if (o + 46 > buf.length || u32(buf, o) !== 0x02014b50) throw new Error('zip: битый каталог');
    const method = u16(buf, o + 10);
    const csize = u32(buf, o + 20);
    const usize = u32(buf, o + 24);
    const nameLen = u16(buf, o + 28);
    const extraLen = u16(buf, o + 30);
    const cmtLen = u16(buf, o + 32);
    const lho = u32(buf, o + 42); // смещение локальной записи
    const name = buf.slice(o + 46, o + 46 + nameLen).toString('utf8');
    if (name.endsWith('/')) continue; // каталог — создаётся по ходу файлов
    if (usize > MAX_ENTRY_UNCOMPRESSED) throw new Error('zip: запись слишком велика: ' + name);
    total += usize;
    if (total > MAX_TOTAL_UNCOMPRESSED) throw new Error('zip: суммарный размер зашкаливает');

    // локальная запись: пропускаем её заголовок (имя/extra могут отличаться от ЦД)
    if (lho + 30 > buf.length || u32(buf, lho) !== 0x04034b50) throw new Error('zip: битая локальная запись');
    const lNameLen = u16(buf, lho + 26);
    const lExtraLen = u16(buf, lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const comp = buf.slice(dataStart, dataStart + csize);

    let data;
    if (method === 0) data = comp;
    else if (method === 8) data = zlib.inflateRawSync(comp);
    else throw new Error('zip: метод сжатия ' + method + ' не поддержан: ' + name);

    const dest = safeJoin(destDir, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    out.push({ name, size: data.length });
  }
  return out;
}

// SHA-256 файла (для сверки с реестром)
function sha256(file) {
  return require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

module.exports = { extract, sha256 };
