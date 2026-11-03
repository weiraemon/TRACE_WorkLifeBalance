import { expect, it } from 'vitest';
import { qqSetupArguments } from '../apps/desktop/qq-setup';

it('初始化参数保留中文、空格和单引号路径，用户内容始终作为字面量', () => {
  const args = qqSetupArguments('D:\\CHAOS 安装', {
    dataDir: "D:\\资料\\O'Brien\\$(Write-Output test)\\nt_qq",
    selfQQ: ' 123456789 ',
  });
  const command = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
  expect(command).toBe(
    "& 'D:\\CHAOS 安装\\scripts\\setup-qq.ps1' -DataDir 'D:\\资料\\O''Brien\\$(Write-Output test)\\nt_qq' -SelfQQ '123456789'",
  );
  expect(args).toContain('-NoExit');
});
it('主进程拒绝缺失、相对路径和非法 QQ 号，不依赖前端校验', () => {
  for (const input of [
    null,
    {},
    { dataDir: 'relative', selfQQ: '123456' },
    { dataDir: 'D:\\QQ', selfQQ: '123;exit' },
    { dataDir: 'D:\\QQ\nexit', selfQQ: '123456' },
  ])
    expect(() => qqSetupArguments('D:\\CHAOS', input)).toThrow();
});
