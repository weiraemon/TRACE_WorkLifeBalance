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
  } else throw new Error(`License text missing: ${pkg.name}`);
  output += `\n## ${pkg.name} ${pkg.version}\n\nDeclared license: ${pkg.license ?? entry.license ?? 'See text'}\n\nSource: ${source}\n\n\`\`\`text\n${license.trim()}\n\`\`\`\n`;
}
await fs.writeFile('THIRD_PARTY_NOTICES.md', output);
console.log('Production license notices generated.');
