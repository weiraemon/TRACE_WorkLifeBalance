import { PlusIcon } from '@radix-ui/react-icons';
import type { BusinessLine, Milestone, Todo } from '../../../../../packages/domain/index';
import { ImportanceDot } from '../../components/Importance';
import { MilestonePoint, type MilestonePointProps } from './MilestonePoint';
export function BusinessLineTrack({
  line,
  points,
  todos,
  ...pointProps
}: Omit<MilestonePointProps, 'point' | 'todos'> & {
  line: BusinessLine;
  points: Milestone[];
  todos: Todo[];
}) {
  const { select, edit, drag } = pointProps;
  return (
    <section
      className="business-track"
      key={line.id}
      data-space-id={line.id}
      {...drag.targetProps(line.id)}
      aria-label={`业务线 · ${line.title}`}
    >
      <div className="track-scroll">
        <div className="track-points">
          <div className={`track-nodes priority-${line.importance}`}>
            <div className="line-origin">
              <button
                className="line-title"
                onClick={() => select(line.id)}
                {...drag.sourceProps(line)}
              >
                <strong>{line.title}</strong>
              </button>
              <button className="line-importance" aria-label={`编辑重要性 · ${line.title}`}>
                <ImportanceDot value={line.importance} />
              </button>
            </div>
            {points
              .filter((point) => !point.pool)
              .map((point) => (
                <MilestonePoint
                  key={point.id}
                  {...pointProps}
                  point={point}
                  todos={todos.filter((todo) => todo.milestoneId === point.id)}
                />
              ))}
            <button
              className="add-point"
              onClick={() => edit({ type: 'milestone', defaults: { lineId: line.id } })}
            >
              <PlusIcon />
              关键节点
            </button>
          </div>
          {points
            .filter((point) => point.pool)
            .map((point) => (
              <MilestonePoint
                key={point.id}
                {...pointProps}
                point={point}
                todos={todos.filter((todo) => todo.milestoneId === point.id)}
              />
            ))}
        </div>
      </div>
    </section>
  );
}
