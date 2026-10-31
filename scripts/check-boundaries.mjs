import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
const errors = [];
function files(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((item) =>
      item.isDirectory()
        ? files(dir + '/' + item.name)
        : /\.tsx?$/.test(item.name)
          ? [dir + '/' + item.name]
          : [],
    );
}
for (const file of files('apps/local-service/src').concat(files('apps/desktop'), [
  'packages/domain/business.ts',
])) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
    const specifier = node.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) continue;
    const target = path.resolve(path.dirname(file), specifier.text).replaceAll('\\', '/');
    const native = file.includes('/native/');
    if (file.startsWith('apps/desktop/') && /\/(?:native|application|domain)\//.test(target))
      errors.push(
        file + ': desktop shell must use the shared service, not business/storage internals',
      );
    const business =
      file.endsWith('/workspace-service.ts') || file === 'packages/domain/business.ts';
    if (
      (native || business) &&
      /\/(?:sync|adapters)\/|\/domain\/messages$|\/application\/message-/.test(target)
    )
      errors.push(file + ': core business/storage must not import ' + specifier.text);
    if (
      file.endsWith('/qq-sync.ts') &&
      /\/native\//.test(target) &&
      !(ts.isImportDeclaration(node) && node.importClause?.isTypeOnly)
    )
      errors.push(file + ': QQ may only import native storage types');
  }
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('Architecture boundaries OK');
