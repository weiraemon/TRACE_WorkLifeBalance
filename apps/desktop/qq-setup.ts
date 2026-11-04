import path from 'node:path';

export function qqSetupArguments(root: string, input: unknown, resultFile?: string): string[] {
  const value = input as { dataDir?: unknown; selfQQ?: unknown } | null;
  const dataDir = typeof value?.dataDir === 'string' ? value.dataDir.trim() : '';
  const selfQQ = typeof value?.selfQQ === 'string' ? value.selfQQ.trim() : '';
  if (!/^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i.test(dataDir) || /[\r\n\x00]/.test(dataDir))
    throw new Error('请填写 QQ 数据目录的完整路径');
  if (!/^\d{5,12}$/.test(selfQQ)) throw new Error('请填写 5–12 位数字 QQ 号');
  // Encode a command with literal PowerShell strings; never pass user input through cmd.exe.
  const literal = (text: string) => "'" + text.replaceAll("'", "''") + "'";
  const command = `& ${literal(path.win32.join(root, 'scripts', 'setup-qq.ps1'))} -DataDir ${literal(dataDir)} -SelfQQ ${literal(selfQQ)}${resultFile ? ` -ResultFile ${literal(resultFile)}` : ''}`;
  return [
    '-NoProfile',
    '-NoExit',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(command, 'utf16le').toString('base64'),
  ];
}
