import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import ts from 'typescript';

const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));
const retiredRoutes = new Set([
  'snapshot',
  'records',
  'content',
  'notes',
  'promote',
  'delete-preview',
  'delete-space',
]);
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

function check(file, text) {
  const errors = [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const domain = file.startsWith('packages/domain/');
  const workspace = file.startsWith('packages/workspace/');
  const web = file.startsWith('apps/web/');
  const native = file.startsWith('apps/local-service/src/native/');
  const shell = file.startsWith('apps/desktop/');
  const fail = (message) => errors.push(file + ': ' + message);
  function dependency(specifier, typeOnly = false) {
    const target = specifier.startsWith('.')
      ? path.resolve(path.dirname(file), specifier).replaceAll('\\', '/')
      : specifier;
    const system = builtins.has(specifier.replace(/^node:/, '')) || specifier === 'electron';
    if ((domain || workspace || web) && system) fail('portable code must not import ' + specifier);
    if ((domain || workspace) && /\/apps\//.test(target))
      fail('shared code must not depend on an app: ' + specifier);
    if (domain && /\/packages\/workspace\//.test(target))
      fail('domain must not depend on application services');
    if (web && /\/apps\/(?:local-service|desktop)\/|\/packages\/workspace\//.test(target))
      fail('UI must use its client/platform entry points: ' + specifier);
    if (shell && /\/(?:native|application|domain|workspace)\//.test(target))
      fail('desktop shell must use the shared service, not business/storage internals');
    if (
      (native || workspace || file === 'packages/domain/business.ts') &&
      /\/(?:sync|adapters)\/|\/domain\/messages$|\/application\/message-/.test(target)
    )
      fail('core business/storage must not import ' + specifier);
    if (file.endsWith('/qq-sync.ts') && /\/native\//.test(target) && !typeOnly)
      fail('QQ may only import native storage types');
  }
  function visit(node) {
    if (
      ts.isStringLiteral(node) &&
      node.text.startsWith('/api/') &&
      retiredRoutes.has(node.text.slice(5))
    )
      fail('retired work routes must not be restored; use /api/business/v1');
    if (
      web &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'api' &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      retiredRoutes.has(node.arguments[0].text)
    )
      fail('UI work operations must use the standard business API');
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        dependency(
          node.moduleSpecifier.text,
          ts.isImportDeclaration(node) && node.importClause?.isTypeOnly,
        );
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const specifier = node.moduleReference.expression;
      if (specifier && ts.isStringLiteral(specifier)) dependency(specifier.text, node.isTypeOnly);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      dependency(node.arguments[0].text);
    }
    if (ts.isIdentifier(node)) {
      if (
        (domain || workspace) &&
        ['process', 'Buffer', '__dirname', '__filename', 'require'].includes(node.text)
      )
        fail('shared code must use platform-neutral APIs, found ' + node.text);
      if (web && node.text === 'chaosDesktop' && file !== 'apps/web/src/platform/desktop.ts')
        fail('Electron bridge access belongs in platform/desktop.ts');
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return errors;
}

// Exercise rejected edges as well as the allowed dependency direction.
for (const code of [
  "import fs from 'node:fs';",
  "export { readFile } from 'fs/promises';",
  "void import('node:crypto');",
  "const fs = require('fs');",
  "import x from '../../apps/local-service/src/native/vault';",
  "import x from '../domain/messages';",
  'process.cwd();',
])
  assert.ok(check('packages/workspace/probe.ts', code).length, code);
assert.equal(
  check(
    'packages/workspace/probe.ts',
    "import { parseRecord } from '../domain/index'; crypto.randomUUID();",
  ).length,
  0,
);
assert.ok(check('apps/web/src/pages/probe.tsx', 'window.chaosDesktop;').length);
assert.ok(check('apps/web/src/probe.ts', "api('records', {});").length);
assert.ok(check('apps/local-service/src/server.ts', "const route = '/api/records';").length);
assert.ok(
  check('apps/desktop/probe.ts', "import { Workspace } from '../../packages/workspace/workspace';")
    .length,
);
assert.equal(
  check('apps/local-service/src/sync/qq-sync.ts', "import type { Vault } from '../native/vault';")
    .length,
  0,
);
assert.ok(
  check('apps/local-service/src/sync/qq-sync.ts', "import { Vault } from '../native/vault';")
    .length,
);

const errors = files('apps')
  .concat(files('packages'))
  .flatMap((file) => check(file, fs.readFileSync(file, 'utf8')));
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('Architecture boundaries OK (including portable workspace and UI/platform boundaries)');
