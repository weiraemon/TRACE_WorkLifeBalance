import { mkdir, writeFile } from 'node:fs/promises';
const repos = [
  'shadcn-ui/ui',
  'radix-ui/primitives',
  'tailwindlabs/tailwindcss',
  'clauderic/dnd-kit',
  'TanStack/table',
  'TanStack/virtual',
  'react-hook-form/react-hook-form',
  'colinhacks/zod',
  'pmndrs/zustand',
  'fullcalendar/fullcalendar',
  'obsidian-tasks-group/obsidian-tasks',
  'blacksmithgu/obsidian-dataview',
  'obsidianmd/obsidian-sample-plugin',
  'toeverything/AFFiNE',
];
const results = await Promise.all(
  repos.map(async (repo) => {
    try {
      const response = await fetch(`https://api.github.com/repos/${repo}`, {
        headers: { 'User-Agent': 'ATLAS-reuse-evaluation' },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(String(response.status));
      const r = await response.json();
      return {
        repo,
        url: r.html_url,
        stars: r.stargazers_count,
        pushedAt: r.pushed_at,
        archived: r.archived,
        license: r.license?.spdx_id ?? 'unknown',
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      return { repo, error: String(error) };
    }
  }),
);
await mkdir('docs/architecture', { recursive: true });
await writeFile('docs/architecture/reuse-sources.json', JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
