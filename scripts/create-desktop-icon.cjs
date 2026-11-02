const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

const [source, output] = process.argv.slice(2);
app.disableHardwareAcceleration();
app
  .whenReady()
  .then(async () => {
    const svg = await fs.readFile(source, 'utf8');
    const window = new BrowserWindow({
      width: 1024,
      height: 1024,
      useContentSize: true,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: {
        offscreen: true,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    const painted = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Icon rendering timed out')), 15000);
      const rendered = (_event, _dirty, image) => {
        if (image.isEmpty() || image.resize({ width: 1, height: 1 }).toBitmap()[3] === 0) return;
        clearTimeout(timer);
        window.webContents.removeListener('paint', rendered);
        resolve(image);
      };
      window.webContents.on('paint', rendered);
    });
    await window.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          '<!doctype html><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}svg{display:block;width:100%;height:100%}</style>' +
            svg,
        ),
    );
    const image = await painted;
    assert.ok(!image.isEmpty(), 'The icon must render before export');
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(
      path.join(output, 'icon.png'),
      image.resize({ width: 512, height: 512, quality: 'best' }).toPNG(),
    );
    const sizes = [16, 24, 32, 48, 64, 128, 256];
    const header = Buffer.alloc(6 + sizes.length * 16);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(sizes.length, 4);
    const frames = [];
    let offset = header.length;
    for (const [index, size] of sizes.entries()) {
      const png = image.resize({ width: size, height: size, quality: 'best' }).toPNG();
      assert.equal(png.readUInt32BE(16), size);
      assert.equal(png.readUInt32BE(20), size);
      const entry = 6 + index * 16;
      header[entry] = header[entry + 1] = size === 256 ? 0 : size;
      header.writeUInt16LE(1, entry + 4);
      header.writeUInt16LE(32, entry + 6);
      header.writeUInt32LE(png.length, entry + 8);
      header.writeUInt32LE(offset, entry + 12);
      offset += png.length;
      frames.push(png);
    }
    await fs.writeFile(path.join(output, 'icon.ico'), Buffer.concat([header, ...frames]));
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
