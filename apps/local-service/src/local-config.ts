import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const configSchema = z
  .object({
    vaultPath: z.string().refine(path.isAbsolute, '工作目录配置需要绝对路径').optional(),
  })
  .passthrough();

export async function readLocalConfig(filename: string) {
  try {
    return configSchema.parse(JSON.parse(await fs.readFile(filename, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export async function rememberVault(filename: string, vaultPath: string) {
  const config = configSchema.parse({ ...(await readLocalConfig(filename)), vaultPath });
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
    await fs.rename(temporary, filename);
  } finally {
    await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
