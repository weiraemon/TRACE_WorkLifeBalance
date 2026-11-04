import fs from 'node:fs/promises';
import path from 'node:path';
const lock = JSON.parse(await fs.readFile('package-lock.json', 'utf8'));
const previousNotices = await fs.readFile('THIRD_PARTY_NOTICES.md', 'utf8').catch(() => '');
let output =
  '# Third-party notices\n\nGenerated from the locked production dependencies. Each dependency retains its own license.\n';
for (const [directory, entry] of Object.entries(lock.packages)) {
  if (!directory || entry.dev) continue;
  const pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  const files = await fs.readdir(directory);
  const name = files.find((name) => /^licen[cs]e(?:\.|$)/i.test(name));
  let license,
    source = 'Installed package ' + directory;
  const previousSection = previousNotices
    .split(`\n## ${pkg.name} ${pkg.version}\n`)[1]
    ?.split('\n## ')[0];
  const previousLicense = previousSection?.match(/```text\n([\s\S]*?)\n```/);
  if (name) license = await fs.readFile(path.join(directory, name), 'utf8');
  else if (previousLicense) {
    license = previousLicense[1];
    source = previousSection.match(/Source: (.+)/)?.[1] ?? source;
  } else if (pkg.name === 'react-remove-scroll-bar') {
    source = 'https://raw.githubusercontent.com/theKashey/react-remove-scroll-bar/master/LICENSE';
    const response = await fetch(source, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Upstream license unavailable: ${response.status}`);
    license = await response.text();
  } else if (pkg.name === 'qrcode-generator') {
    source = 'Installed package qrcode-generator/dist/qrcode.mjs (copyright and MIT declaration)';
    license = `MIT License

Copyright (c) 2009 Kazuhiko Arase

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.`;
  } else throw new Error(`License text missing: ${pkg.name}`);
  output += `\n## ${pkg.name} ${pkg.version}\n\nDeclared license: ${pkg.license ?? entry.license ?? 'See text'}\n\nSource: ${source}\n\n\`\`\`text\n${license.trim()}\n\`\`\`\n`;
}
output +=
  '\n## Android QR scanning\n\nZXing Android Embedded 4.3.0 (Journey Mobile) and ZXing Core 3.4.1 (ZXing authors).\n\nDeclared license: Apache-2.0\n\nSources: https://github.com/journeyapps/zxing-android-embedded and https://github.com/zxing/zxing\n\n```text\n' +
  (await fs.readFile('apps/android/native/third-party/ZXing-LICENSE.txt', 'utf8')).trim() +
  '\n```\n';
await fs.writeFile('THIRD_PARTY_NOTICES.md', output);
console.log('Production license notices generated.');
