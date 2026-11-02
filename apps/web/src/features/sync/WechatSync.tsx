import { Button } from '../../components/ui';

export function WechatSync({ mode = 'settings' }: { mode?: 'pending' | 'settings' }) {
  if (mode === 'pending')
    return (
      <section className="message-inbox" aria-label="微信消息">
        <p className="hint">微信同步尚未接入，暂无待确认消息。</p>
      </section>
    );
  return (
    <section className="message-inbox" aria-label="微信同步设置">
      <p className="message-notice" role="status">
        微信同步尚未接入。接入后会与 QQ 一样支持会话规则、自动同步和待确认。
      </p>
      <h3>微信同步设置</h3>
      <p className="hint">接入后可绑定微信会话、限定项目或默认业务线，并选择是否同步本人消息。</p>
      <Button disabled>读取微信会话列表</Button>
    </section>
  );
}
