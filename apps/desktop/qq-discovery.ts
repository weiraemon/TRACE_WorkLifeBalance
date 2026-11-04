import fs from 'node:fs/promises';
import path from 'node:path';

export type QqAccount = { dataDir: string; selfQQ: string; modified: string };

// Bounded breadth-first search; never follow junctions into unrelated directories.
export async function discoverQq(
  roots: string[],
): Promise<{ accounts: QqAccount[]; limited: boolean }> {
  const queue = roots.filter(Boolean).map((dir) => ({ dir: path.resolve(dir), depth: 0 }));
  const seen = new Set<string>();
  const accounts: QqAccount[] = [];
  const deadline = Date.now() + 10000;
  let limited = false;
  while (queue.length && seen.size < 2500 && Date.now() < deadline) {
    const { dir, depth } = queue.shift()!;
    const canonical = dir.toLowerCase();
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    try {
      if ((await fs.lstat(dir)).isSymbolicLink()) continue;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      if (entries.some((entry) => entry.name === 'nt_msg.db' && entry.isFile())) {
        const selfQQ = dir
          .split(/[\\/]/)
          .reverse()
          .find((part) => /^\d{5,12}$/.test(part));
        if (selfQQ)
          accounts.push({
            dataDir: dir,
            selfQQ,
            modified: (await fs.stat(path.join(dir, 'nt_msg.db'))).mtime.toISOString(),
          });
        continue;
      }
      if (depth >= 6) {
        limited = true;
        continue;
      }
      for (const entry of entries) {
        if (
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          !['node_modules', '.git', 'Windows', '$RECYCLE.BIN'].includes(entry.name)
        )
          queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    } catch {
      /* Missing or inaccessible directories are not candidates. */
    }
  }
  return {
    accounts: accounts.sort((a, b) => b.modified.localeCompare(a.modified)),
    limited: limited || queue.length > 0,
  };
}
