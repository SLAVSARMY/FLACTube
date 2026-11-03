// SVG → PNG с прозрачностью: offscreen-окно Electron рендерит и снимает кадр.
// Использование: npx electron scripts/svg2png.js <in.svg> <out.png> [size]
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const [, , svgPath, outPath, sizeArg] = process.argv;
const size = parseInt(sizeArg || '1024', 10);
if (!svgPath || !outPath) { console.error('用法: svg2png <in.svg> <out.png> [size]'); app.exit(1); }

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.resolve(svgPath), 'utf8');
  const inner = svg.replace(/<svg /, '<svg style="width:100%;height:100%;display:block" ');
  const html = '<!doctype html><html><head><style>*{margin:0;padding:0}html,body{background:transparent;width:' + size + 'px;height:' + size + 'px}</style></head>'
    + '<body><div style="width:' + size + 'px;height:' + size + 'px">' + inner + '</div></body></html>';
  const win = new BrowserWindow({
    show: false, transparent: true, width: size, height: size, useContentSize: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 400)); // градиенты/шрифты должны доехать
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  const buf = img.toPNG();
  fs.writeFileSync(path.resolve(outPath), buf);
  console.log('OK', outPath, size + 'x' + size, (buf.length / 1024).toFixed(0) + ' КБ', 'alpha:', img.getAlphaBitmap ? 'n/a' : 'png32');
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });
