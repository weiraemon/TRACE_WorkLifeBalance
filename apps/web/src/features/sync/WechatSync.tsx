import { useState } from 'react';
import { Button, Field } from '../../components/ui';

export function WechatSync() {
  const [tab, setTab] = useState<'inbox' | 'manual' | 'settings'>('manual');
  return (
    <section className="message-inbox" aria-label="微信同步设置">
      <p className="message-notice" role="status">
        微信同步尚未接入。以下界面为占位，接入后操作逻辑与 QQ 同步一致。
      </p>
      <div className="segmented">
        <button aria-pressed={tab === 'inbox'} onClick={() => setTab('inbox')}>
          待确认（0）
        </button>
        <button aria-pressed={tab === 'manual'} onClick={() => setTab('manual')}>
          微信手动同步
        </button>
        <button aria-pressed={tab === 'settings'} onClick={() => setTab('settings')}>
          会话与识别设置
        </button>
      </div>
      {tab === 'inbox' ? (
        <p className="hint">微信数据源尚未接入，暂无待确认事项。</p>
      ) : tab === 'manual' ? (
        <>
          <h3>微信手动同步</h3>
          <p className="hint">
            接入后可选择微信聊天和时间段，并决定是否同步本人消息、是否自动加入计划。
          </p>
          <form onSubmit={(e) => e.preventDefault()}>
            <Field label="会话">
              <select disabled>
                <option>微信聊天尚未接入</option>
              </select>
            </Field>
            <Field label="开始时间（北京时间）">
              <input disabled type="datetime-local" />
            </Field>
            <Field label="结束时间（北京时间）">
              <input disabled type="datetime-local" />
            </Field>
            <label>
              <input disabled type="checkbox" />
              同步本人发送的消息
            </label>
            <label>
              <input disabled type="checkbox" />
              自动加入计划（跳过待确认）
            </label>
            <Button disabled>开始手动同步</Button>
          </form>
        </>
      ) : (
        <>
          <h3>会话与识别设置</h3>
          <p className="hint">
            接入后与 QQ 相同：绑定微信会话、限定项目或默认业务线、选择本人消息与自动加入计划。
          </p>
          <Button disabled>读取微信会话列表</Button>
        </>
      )}
    </section>
  );
}
