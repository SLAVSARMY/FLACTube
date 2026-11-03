const fs = require('fs');
const p = 'D:/youtube/ytm-desktop/inject-preload.js';
let s = fs.readFileSync(p, 'utf8');

// 1. mmss: убрать миллисекунды + объявить shuffleOn
s = s.replace(
  "const mmss = (s) => Math.floor((s || 0) / 60) + ':' + String((s || 0) % 60).padStart(2, '0');",
  "const mmss = (s) => {\n  s = Math.max(0, Math.floor(s || 0));\n  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');\n};\nlet shuffleOn = false;"
);

// 2. libNext: поддержка шафла
s = s.replace(
`function libNext(dir) {
  if (!libMode) return;
  let i = libMode.index + dir;
  if (i >= libMode.list.length) { libStop(); return; }
  if (i < 0) i = libMode.list.length - 1;
  libPlayById(libMode.list[i].id);
}`,
`function libNext(dir) {
  if (!libMode) return;
  let i;
  if (shuffleOn) {
    if (!libMode.order || libMode.order.length !== libMode.list.length) {
      libMode.order = libMode.list.map((_, k) => k).sort(() => Math.random() - 0.5);
    }
    let p = libMode.order.indexOf(libMode.index) + dir;
    if (p >= libMode.order.length) { libStop(); return; }
    if (p < 0) p = libMode.order.length - 1;
    i = libMode.order[p];
  } else {
    i = libMode.index + dir;
    if (i >= libMode.list.length) { libStop(); return; }
    if (i < 0) i = libMode.list.length - 1;
  }
  libPlayById(libMode.list[i].id);
}`
);

fs.writeFileSync(p, s);
console.log('patched:', s.includes('shuffleOn') && s.includes('Math.floor(s || 0)'));
