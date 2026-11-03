// Background pipeline-run registry.
//
// Decouples an Edpresso Shot generation run from the HTTP request that triggered it. The run executes as a
// detached promise; the request only attaches as a subscriber to its event stream. When the
// browser tab closes, we *unsubscribe* (not abort), so the work continues and the on-disk record
// keeps updating. A separate cancel endpoint can stop the run by id.
//
// Stored events are buffered so a re-attaching client (e.g. reopening a Shot while a run is in
// flight) can replay everything that happened before it connected.

import { runEdpressoPipeline, ANSWER_TYPES, type EdpressoInput, type StageEvent } from './edpressoPipeline';
import { runWithAbort, isAbortError } from './abortContext';
import { saveBlog, getBlog, newBlogId, type SavedBlog } from './storage';

type Subscriber = (event: any) => void;

interface RunHandle {
  id: string;
  abort: AbortController;
  events: any[]; // includes 'meta', 'stage', 'data', 'log', 'final', 'done', 'error', 'cancelled'
  subscribers: Set<Subscriber>;
  done: boolean;
  record: SavedBlog;
  pendingFlush: NodeJS.Timeout | null;
  lastFlushAt: number;
  // Per-stage latest streaming payload. Stream events fire ≈30ms apart and would flood the
  // replay buffer if pushed into `events`. We retain only the most recent payload per stage and
  // replay it once on subscribe so late re-attaches still see the live draft.
  lastStreams: Map<string, string>;
}

declare global { var __blogRuns: Map<string, RunHandle> | undefined; }
const RUNS: Map<string, RunHandle> = global.__blogRuns ?? (global.__blogRuns = new Map());
const PERSIST_THROTTLE_MS = 750;
// How long to keep a finished run in memory so late re-attaches still get the full event log.
// After this we rely on the on-disk record.
const FINISHED_TTL_MS = 60_000;

function broadcast(handle: RunHandle, event: any) {
  if (event?.type === 'stream' && event.name) {
    // Don't buffer — overwrite per-stage latest. Late subscribers get one synthetic stream event.
    handle.lastStreams.set(event.name, event.payload);
  } else {
    handle.events.push(event);
  }
  for (const s of handle.subscribers) {
    try { s(event); } catch {}
  }
}

async function flushRecord(handle: RunHandle) {
  handle.lastFlushAt = Date.now();
  handle.pendingFlush = null;
  handle.record.updatedAt = new Date().toISOString();
  try {
    await saveBlog(handle.record);
  } catch (e) {
    console.error('[runManager] flush failed', e);
  }
}

function scheduleFlush(handle: RunHandle) {
  if (handle.pendingFlush) return;
  const delay = Math.max(0, PERSIST_THROTTLE_MS - (Date.now() - handle.lastFlushAt));
  handle.pendingFlush = setTimeout(() => { void flushRecord(handle); }, delay);
}

export function startEdpressoRun(input: EdpressoInput): RunHandle {
  const id = newBlogId();
  const startedAt = new Date().toISOString();
  const record: SavedBlog = {
    id,
    createdAt: startedAt,
    updatedAt: startedAt,
    status: 'running',
    runType: 'edpresso',
    request: {
      vertical: input.answerType && input.answerType !== 'auto' ? ANSWER_TYPES[input.answerType]?.label || '' : '',
      blogTitle: input.title,
      faqs: input.faqs,
      keywords: input.keywords,
      language: input.language,
      answerType: input.answerType,
      competitorUrls: input.competitorUrls,
    },
    stageOutputs: {},
    stageLogs: {},
  };

  const handle: RunHandle = {
    id,
    abort: new AbortController(),
    events: [],
    subscribers: new Set(),
    done: false,
    record,
    pendingFlush: null,
    lastFlushAt: 0,
    lastStreams: new Map(),
  };
  RUNS.set(id, handle);
  // Initial save so the list page shows the record immediately.
  void flushRecord(handle);

  const emit = (e: StageEvent) => {
    if (e?.type === 'data' && (e as any).name) {
      record.stageOutputs![(e as any).name] = (e as any).payload;
      // The answer type is known once classify finishes — surface it on the list page right away.
      if ((e as any).name === 'classify') {
        const t = (e as any).payload?.answerType as keyof typeof ANSWER_TYPES;
        if (t && ANSWER_TYPES[t]) record.request.vertical = ANSWER_TYPES[t].label;
      }
    } else if (e?.type === 'log' && (e as any).name) {
      (record.stageLogs![(e as any).name] ||= []).push((e as any).payload);
    } else if (e?.type === 'final') {
      const p: any = (e as any).payload;
      record.finalTitle = p?.title;
      record.markdown = p?.markdown;
      record.html = p?.html;
      record.edpresso = p?.edpresso;
      record.request.vertical = p?.vertical || record.request.vertical;
    }
    broadcast(handle, e);
    scheduleFlush(handle);
  };

  // Detached: do NOT await this in the caller. The request returns its SSE stream while this
  // promise runs in the background.
  void (async () => {
    broadcast(handle, { type: 'meta', blogId: id });
    try {
      await runWithAbort(handle.abort.signal, () => runEdpressoPipeline(input, emit));
      record.status = 'draft';
      broadcast(handle, { type: 'done', blogId: id });
    } catch (err: any) {
      if (isAbortError(err) || handle.abort.signal.aborted) {
        record.status = 'cancelled';
        record.errorMessage = 'Cancelled by user';
        broadcast(handle, { type: 'cancelled', blogId: id });
      } else {
        record.status = 'failed';
        record.errorMessage = err?.message || String(err);
        broadcast(handle, { type: 'error', message: record.errorMessage });
      }
    } finally {
      handle.done = true;
      if (handle.pendingFlush) { clearTimeout(handle.pendingFlush); handle.pendingFlush = null; }
      await flushRecord(handle);
      // Hold the handle a bit so a client that re-attaches just after completion sees terminal events.
      setTimeout(() => RUNS.delete(id), FINISHED_TTL_MS);
    }
  })();

  return handle;
}

export function getRun(id: string): RunHandle | undefined {
  return RUNS.get(id);
}

export function cancelRun(id: string): boolean {
  const handle = RUNS.get(id);
  if (!handle || handle.done) return false;
  handle.abort.abort();
  return true;
}

// Subscribe to live events. Returns the buffered prelude (already-emitted events) and a function
// to detach. Detaching does NOT cancel the run — that's deliberate: we want browser navigations
// to leave the work running.
export function subscribe(id: string, listener: Subscriber): { backlog: any[]; unsubscribe: () => void; done: boolean } | null {
  const handle = RUNS.get(id);
  if (!handle) return null;
  handle.subscribers.add(listener);
  const backlog = [...handle.events];
  // Replay latest stream payload(s) so a late re-attach sees the in-progress draft, not a blank panel.
  for (const [name, payload] of handle.lastStreams) {
    backlog.push({ type: 'stream', name, payload });
  }
  return {
    backlog,
    done: handle.done,
    unsubscribe: () => handle.subscribers.delete(listener),
  };
}

// Helper for the list page — distinguishes 'live' (server still owns it) from records that
// are merely 'running' on disk because the server restarted mid-run.
export function isLive(id: string): boolean {
  const h = RUNS.get(id);
  return !!h && !h.done;
}

// On startup or list, mark stuck-on-disk 'running' records as failed if they aren't live.
export async function reconcileOrphan(id: string): Promise<void> {
  if (isLive(id)) return;
  const rec = await getBlog(id);
  if (!rec || rec.status !== 'running') return;
  rec.status = 'failed';
  rec.errorMessage = (rec.errorMessage || '') + (rec.errorMessage ? ' · ' : '') + 'Server restarted before completion';
  await saveBlog(rec);
}
