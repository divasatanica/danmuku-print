import type { useConsole } from './use-console.ts';

const connectionLabels = {
  disconnected: '未连接', connecting: '连接中', connected: '已连接', reconnecting: '重连中',
};

export function PrintConsole({ status, draft, busy, apiError, pollFailed, edit, mutate }: ReturnType<typeof useConsole>) {
  const listening = status?.phase === 'listening';
  const taskLocked = busy || status?.phase !== 'idle';
  const quotaLocked = busy || !listening;
  const keywordsLocked = busy || status?.phase === 'draining';
  const keywordsDirty = listening && draft.keywords.trim() !== status.keywords;
  let connection = '正在读取状态';
  if (pollFailed) connection = '无法读取打印服务状态';
  else if (status?.phase === 'draining') connection = '已停止监听 · 正在清空队列';
  else if (status) connection = connectionLabels[status.connection];

  let remaining = '—';
  if (status) remaining = status.limit === null ? '不限量' : `${status.remaining} / ${status.limit}`;

  return (
    <>
      <section className="card overview" aria-labelledby="status-heading">
        <div className="overview-title">
          <h2 id="status-heading">任务状态</h2>
          <p id="connection" role="status">{connection}</p>
        </div>
        {status?.connectionError && <p className="notice">{status.connectionError}</p>}
        <dl className="stats">
          <div><dt>剩余额度</dt><dd>{remaining}</dd></div>
          <div><dt>排队数</dt><dd>{status?.queued ?? '—'}</dd></div>
          <div><dt>成功数</dt><dd>{status?.succeeded ?? '—'}</dd></div>
          <div><dt>失败数</dt><dd>{status?.failed ?? '—'}</dd></div>
        </dl>
        {status?.printing && <p className="hint">正在处理 1 条打印任务。</p>}
      </section>

      <div className="controls">
        <form className="card" aria-labelledby="listener-heading" onSubmit={event => {
          event.preventDefault();
          void mutate('/api/start', { roomId: draft.roomId, keywords: draft.keywords });
        }}>
          <h2 id="listener-heading">直播间监听</h2>
          <div className="field">
            <label htmlFor="room">直播间号（必填）</label>
            <input id="room" name="roomId" inputMode="numeric" pattern="[0-9]{1,32}" maxLength={32}
              required readOnly={taskLocked} value={draft.roomId}
              onChange={event => edit('roomId', event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="keywords">关键词（选填）</label>
            <textarea id="keywords" name="keywords" rows={3} maxLength={2000}
              aria-describedby="keyword-help" readOnly={keywordsLocked} value={draft.keywords}
              onChange={event => edit('keywords', event.target.value)} />
            <p id="keyword-help" className="hint">留空时，只匹配去掉所有空格后的整数或小数。填写时，用逗号或换行分隔；匹配时忽略空格和英文字母大小写。监听中可直接修改，点「更新关键词」对之后的弹幕生效；已入队的任务和剩余额度不受影响。</p>
          </div>
          <div className="actions">
            <button type="submit" disabled={taskLocked}>开始监听</button>
            <button type="button" disabled={!keywordsDirty} onClick={() => void mutate('/api/keywords', {
              keywords: draft.keywords,
            })}>更新关键词</button>
            <button type="button" className="secondary" disabled={quotaLocked}
              onClick={() => void mutate('/api/stop', {})}>停止监听</button>
          </div>
        </form>

        <form className="card" aria-labelledby="quota-heading" onSubmit={event => {
          event.preventDefault();
          void mutate('/api/limit', { limit: Number(draft.limit) });
        }}>
          <h2 id="quota-heading">打印额度</h2>
          <div className="field">
            <label htmlFor="limit">打印上限</label>
            <input id="limit" name="limit" inputMode="numeric" pattern="[0-9]+" maxLength={16}
              aria-describedby="quota-help" required readOnly={quotaLocked} value={draft.limit}
              onChange={event => edit('limit', event.target.value)} />
            <p id="quota-help" className="hint">监听开始后可设置正整数。每次设置均从下一条弹幕重新计数。</p>
          </div>
          <div className="actions">
            <button type="submit" disabled={quotaLocked}>设置上限</button>
            <button type="button" className="secondary" disabled={quotaLocked}
              onClick={() => void mutate('/api/limit', { limit: null })}>清除限制</button>
          </div>
        </form>
      </div>
      <div role="alert">{apiError && <p className="notice">{apiError}</p>}</div>
    </>
  );
}
