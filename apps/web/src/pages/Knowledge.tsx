import { useState } from 'react';
import { noteKindLabel, type Snapshot } from '../../../../packages/domain/index';
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
  const [tag, setTag] = useState('');
  const tags = [
    ...new Set(
      resources.flatMap(({ data }) => (data.type === 'resource' && data.tag ? [data.tag] : [])),
    ),
  ].sort();
  return (
    <>
      <section>
        <Field label="标签筛选">
          <select value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">全部</option>
            {tags.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </select>
        </Field>
        {resources.length === 0 && <EmptyState>暂无笔记</EmptyState>}
        {resources.map(
          (e) =>
            e.data.type === 'resource' &&
            (!tag || e.data.tag === tag) && (
              <div className="knowledge-row" key={e.data.id}>
                <button onClick={() => run(() => openResource(e.data.id))}>
                  <strong>{e.data.title} ↗</strong>
                </button>
                <span>
                  {noteKindLabel[e.data.kind]}
                  {e.data.tag ? ` · ${e.data.tag}` : ''}
                </span>
                <Button onClick={() => edit({ type: 'resource', entry: e })}>编辑</Button>
              </div>
            ),
        )}
      </section>
    </>
  );
}
