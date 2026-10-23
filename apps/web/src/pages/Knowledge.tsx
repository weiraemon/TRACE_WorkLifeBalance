import { useState } from 'react';
import type { Snapshot } from '../../../../packages/domain/index';
import type { Editor } from '../features/editor';
import { openResource } from '../api';
import { Button, Field, EmptyState } from '../components/ui';
export function Knowledge({
  snapshot,
  edit,
  run,
}: {
  snapshot: Snapshot;
  edit: (e: Editor) => void;
  run: (fn: () => Promise<unknown>) => void;
}) {
  const resources = snapshot.entries.filter((e) => e.data.type === 'resource');
  const [prefix, setPrefix] = useState('');
  return (
    <>
      <section>
        <h2>共享资源</h2>
        {resources.length === 0 && (
          <EmptyState>关联现有笔记、原生文件、文件夹或网页，不需要迁移知识。</EmptyState>
        )}
        {resources.map(
          (e) =>
            e.data.type === 'resource' && (
              <div className="knowledge-row" key={e.data.id}>
                <button onClick={() => run(() => openResource(e.data.id))}>
                  <strong>{e.data.title} ↗</strong>
                  <small>{e.data.target}</small>
                </button>
                <Button onClick={() => edit({ type: 'resource', entry: e })}>编辑</Button>
              </div>
            ),
        )}
      </section>
      <section className="file-browser">
        <h2>浏览 Vault</h2>
        <Field label="筛选文件路径">
          <input value={prefix} onChange={(e) => setPrefix(e.target.value)} />
        </Field>
        {snapshot.files
          .filter((f) => f.path.toLowerCase().includes(prefix.toLowerCase()))
          .map((f) => (
            <div className="file-row" key={f.path}>
              <span>
                {f.directory ? '▸ ' : '· '}
                {f.path}
              </span>
              <Button
                onClick={() =>
                  edit({
                    type: 'resource',
                    defaults: { title: f.path.split('/').pop(), target: f.path, location: 'vault' },
                  })
                }
              >
                关联
              </Button>
            </div>
          ))}
      </section>
    </>
  );
}
