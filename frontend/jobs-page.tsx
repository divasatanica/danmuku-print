import { useEffect, useRef, useState } from 'react';
import type { JobPage, ListedJob } from '../backend/src/print-jobs.ts';

const labels: Record<ListedJob['state'], string> = {
  pending: '排队中',
  printing: '打印中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  unconfirmed: '待确认',
};
const dateTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' });

export function JobsPage() {
  const [cursors, setCursors] = useState<number[]>([]);
  const before = cursors.at(-1);
  return (
    <section className="card" aria-labelledby="jobs-heading">
      <h2 id="jobs-heading">打印任务</h2>
      <p className="hint">任务按编号从新到旧排列。取消只适用于排队中的任务，重新运行会创建一条新任务。</p>
      <JobsTable key={before ?? 'latest'} before={before}
        previous={before === undefined ? undefined : () => setCursors(items => items.slice(0, -1))}
        next={cursor => setCursors(items => [...items, cursor])} />
    </section>
  );
}

function JobsTable({ before, previous, next }: {
  before: number | undefined;
  previous?: () => void;
  next: (cursor: number) => void;
}) {
  const [page, setPage] = useState<JobPage>();
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const runningAction = useRef(false);

  useEffect(() => {
    if (busy) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const path = before === undefined ? '/api/jobs' : `/api/jobs?before=${before}`;
        const response = await fetch(path, { signal: controller.signal });
        if (!response.ok) throw new Error('无法读取打印任务。');
        const result: JobPage = await response.json();
        if (!controller.signal.aborted) {
          setPage(result);
          setLoadError('');
        }
      } catch {
        if (!controller.signal.aborted) setLoadError('无法读取打印任务，正在重试。');
      }
      if (!controller.signal.aborted) timer = setTimeout(refresh, 2000);
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [before, busy]);

  async function runAction(job: ListedJob, action: 'retry' | 'cancel') {
    if (runningAction.current) return;
    if (action === 'retry' && (job.state === 'succeeded' || job.state === 'unconfirmed')) {
      const message = job.state === 'succeeded'
        ? `任务 #${job.id} 已打印完成。确认再打印一次？`
        : `任务 #${job.id} 可能已出纸。请核实出纸情况后再确认重新打印。`;
      if (!window.confirm(message)) return;
    }

    runningAction.current = true;
    setBusy(true);
    setActionError('');
    setNotice('');
    try {
      const response = await fetch(`/api/jobs/${job.id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '操作失败。');
      setNotice(action === 'retry' ? `已创建重跑任务 #${result.id}。` : `已取消任务 #${job.id}。`);
      setPage(current => current && ({
        ...current,
        jobs: current.jobs.map(row => row.id !== job.id ? row : action === 'cancel'
          ? { ...row, state: 'cancelled' }
          : { ...row, retriedBy: result.id }),
      }));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '操作失败。');
    } finally {
      runningAction.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <div role="alert">{(actionError || loadError) && <p className="notice">{actionError || loadError}</p>}</div>
      <div role="status">{notice && <p className="hint">{notice}</p>}</div>
      {!page && !loadError && <p role="status">正在读取打印任务…</p>}
      {page?.jobs.length === 0 && <p>暂无打印任务。</p>}
      {!!page?.jobs.length && (
        <div className="jobs-scroll" tabIndex={0} role="region" aria-labelledby="jobs-heading">
          <table className="jobs-table" aria-labelledby="jobs-heading">
            <thead><tr>
              <th scope="col">编号</th><th scope="col">弹幕与详情</th><th scope="col">状态</th>
              <th scope="col">入队时间</th><th scope="col">操作</th>
            </tr></thead>
            <tbody>
              {page.jobs.map(job => (
                <tr key={job.id}>
                  <th scope="row">#{job.id}</th>
                  <td className="job-content">
                    <details>
                      <summary title="查看任务详情">{job.content.slice(0, 48) || '查看详情'}{job.content.length > 48 && '…'}</summary>
                      <p className="job-message">{job.content}</p>
                      <dl className="job-details">
                        <div><dt>观众</dt><dd>#{job.viewerNumber} {job.nickname}</dd></div>
                        <div><dt>直播间</dt><dd>{job.roomId}</dd></div>
                        <div><dt>弹幕编号</dt><dd>{job.eventId}</dd></div>
                        {job.retryOf !== null && <div><dt>原任务</dt><dd>#{job.retryOf}</dd></div>}
                      </dl>
                    </details>
                  </td>
                  <td>{labels[job.state]}</td>
                  <td>{job.createdAt ? <time dateTime={job.createdAt}>{dateTime.format(new Date(job.createdAt))}</time> : '—'}</td>
                  <td>
                    {job.state === 'pending' && (
                      <button className="secondary" type="button" disabled={busy}
                        aria-label={`取消任务 #${job.id}`}
                        onClick={() => void runAction(job, 'cancel')}>取消</button>
                    )}
                    {job.retriedBy !== null ? <span>已重跑为 #{job.retriedBy}</span>
                      : job.state !== 'pending' && job.state !== 'printing' && (
                        <button className="secondary" type="button" disabled={busy}
                          aria-label={`重新运行任务 #${job.id}`}
                          onClick={() => void runAction(job, 'retry')}>重新运行</button>
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page && (previous || page.nextBefore !== null) && (
        <div className="actions jobs-pagination">
          <button type="button" className="secondary" disabled={busy || !previous} onClick={previous}>上一页</button>
          <button type="button" className="secondary" disabled={busy || page.nextBefore === null}
            onClick={() => { if (page.nextBefore !== null) next(page.nextBefore); }}>下一页</button>
        </div>
      )}
    </>
  );
}
