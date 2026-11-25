import { useEffect, useRef, useState } from 'react';
import type { Listener } from '../backend/src/listener.ts';

type Status = ReturnType<Listener['status']> & { dyhubUrl: string };
type Draft = { roomId: string; keywords: string; limit: string };
type ConsoleState = { status: Status | null; draft: Draft };
type Command =
  | ['/api/start', { roomId: string; keywords: string }]
  | ['/api/keywords', { keywords: string }]
  | ['/api/stop', Record<string, never>]
  | ['/api/limit', { limit: number | null }];

async function requestStatus(path: string, options?: RequestInit): Promise<Status> {
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败。');
  return result;
}

function applyStatus(previous: ConsoleState, status: Status): ConsoleState {
  const old = previous.status;
  const { roomId, keywords, phase } = status;
  const taskChanged = old?.roomId !== roomId || old?.keywords !== keywords;
  const switchedListening = old !== null && (old.phase === 'listening') !== (phase === 'listening');
  // Keep in-progress edits while listening, but resync when a task starts, stops, or changes.
  const syncTask = roomId !== null && (!old || taskChanged || switchedListening);
  return {
    status,
    draft: {
      roomId: syncTask ? roomId : previous.draft.roomId,
      keywords: syncTask ? keywords : previous.draft.keywords,
      limit: old?.limit !== status.limit ? String(status.limit ?? '') : previous.draft.limit,
    },
  };
}

export function useConsole() {
  const [{ status, draft }, setConsole] = useState<ConsoleState>({
    status: null,
    draft: { roomId: '', keywords: '', limit: '' },
  });
  const [busy, setBusy] = useState(false);
  const [apiError, setApiError] = useState('');
  const [pollFailed, setPollFailed] = useState(false);
  const mutation = useRef({ busy: false, revision: 0 });

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const { revision, busy } = mutation.current;
      const isCurrent = () => !controller.signal.aborted && revision === mutation.current.revision;
      if (!busy) {
        try {
          const next = await requestStatus('/api/status', { signal: controller.signal });
          if (isCurrent()) {
            setConsole(previous => applyStatus(previous, next));
            setPollFailed(false);
          }
        } catch {
          if (isCurrent()) setPollFailed(true);
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 1000);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);

  function edit(field: keyof Draft, value: string) {
    setConsole(previous => ({ ...previous, draft: { ...previous.draft, [field]: value } }));
  }

  async function mutate(...[path, data]: Command) {
    if (mutation.current.busy || !status) return;
    mutation.current.busy = true;
    mutation.current.revision++;
    setBusy(true);
    setApiError('');
    try {
      const next = await requestStatus(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      setConsole(previous => applyStatus(previous, next));
      setPollFailed(false);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : '请求失败。');
    } finally {
      mutation.current.busy = false;
      setBusy(false);
    }
  }

  return { status, draft, busy, apiError, pollFailed, edit, mutate };
}
