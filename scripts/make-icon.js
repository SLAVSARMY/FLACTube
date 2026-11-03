// icon.png (1024) → icon.ico (16/24/32/48/64/128/256, PNG-in-ICO — Vista+).
// Размеры рендерит ffmpeg, упаковывает Node — без внешних зависимостей.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const ff = path.join(root, 'bin', 'ffmpeg.exe');
const src = path.join(root, 'icon.png');
const out = path.join(root, 'icon.ico');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'flactube-ico-'));

const pngs = sizes.map((s) => {
  const p = path.join(tmp, `${s}.png`);
  execFileSync(ff, ['-y', '-hide_banner', '-loglevel', 'error', '-i', src,
    '-vf', `scale=${s}:${s}:flags=lanczos`, p], { stdio: 'ignore' });
  return { s, buf: fs.readFileSync(p) };
});

// ICONDIR + ICONDIRENTRY + PNG-данные
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);      // reserved
header.writeUInt16LE(1, 2);      // type: icon
header.writeUInt16LE(pngs.length, 4);
const entries = [];
let offset = 6 + 16 * pngs.length;
for (const { s, buf } of pngs) {
  const e = Buffer.alloc(16);
  e.writeUInt8(s >= 256 ? 0 : s, 0);   // width
  e.writeUInt8(s >= 256 ? 0 : s, 1);   // height
  e.writeUInt8(0, 2);                  // palette
  e.writeUInt8(0, 3);                  // reserved
  e.writeUInt16LE(1, 4);               // color planes
  e.writeUInt16LE(32, 6);              // bits
  e.writeUInt32LE(buf.length, 8);
  e.writeUInt32LE(offset, 12);
  entries.push(e);
  offset += buf.length;
}
fs.writeFileSync(out, Buffer.concat([header, ...entries, ...pngs.map((p) => p.buf)]));
fs.rmSync(tmp, { recursive: true, force: true });
console.log('OK', out, (fs.statSync(out).size / 1024).toFixed(0) + ' КБ');
