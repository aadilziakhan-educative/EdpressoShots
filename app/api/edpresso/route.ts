import { NextRequest } from 'next/server';
import { startEdpressoRun, subscribe, isLive, reconcileOrphan } from '@/lib/runManager';
import { listBlogs } from '@/lib/storage';
import { getAnswer, isEducativeConfigured, parseAnswerId } from '@/lib/educative';

export const runtime = 'nodejs';
export const maxDuration = 600;

// GET /api/edpresso — list saved Shots, newest first.
export async function GET() {
  let blogs = await listBlogs();
  // If a record says 'running' but no live handle exists (server restarted mid-run), flip it
  // to 'failed' so the list doesn't show a forever-spinning row.
  const orphans = blogs.filter((b) => b.status === 'running' && !isLive(b.id));
  if (orphans.length > 0) {
    await Promise.all(orphans.map((b) => reconcileOrphan(b.id).catch(() => {})));
    blogs = await listBlogs();
  }
  // Decorate running rows with `live` so the UI knows whether Stop will work.
  const decorated = blogs.map((b) => ({ ...b, live: b.status === 'running' && isLive(b.id) }));
  return Response.json({ blogs: decorated });
}

// POST /api/edpresso — start a run and stream its events as SSE.
export async function POST(req: NextRequest) {
  const body = await req.json();
  // Replacing an existing Answer: check the link and that the account can open the Answer before
  // spending minutes generating content for it.
  const existing = String(body?.existingAnswerUrl || '').trim();
  if (existing) {
    const shotId = parseAnswerId(existing);
    if (!shotId) {
      return Response.json({ error: `Not an Answer editor link: "${existing}". Use a link like https://www.educative.io/editor/answereditor/6241014612361216` }, { status: 400 });
    }
    if (!isEducativeConfigured()) {
      return Response.json({ error: 'Replacing an existing Answer needs EDUCATIVE_FLASK_AUTH in .env.local' }, { status: 400 });
    }
    try {
      await getAnswer(shotId);
    } catch (e: any) {
      return Response.json({ error: String(e?.message || e) }, { status: 400 });
    }
    body.existingAnswerUrl = existing;
  }
  const handle = startEdpressoRun(body);

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      const send = (e: any) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const sub = subscribe(handle.id, send)!;
      for (const e of sub.backlog) send(e);
      if (sub.done) {
        closed = true;
        try { controller.close(); } catch {}
        return;
      }

      const wrap = (e: any) => {
        send(e);
        if (e?.type === 'done' || e?.type === 'error' || e?.type === 'cancelled') {
          closed = true;
          sub.unsubscribe();
          try { controller.close(); } catch {}
        }
      };
      sub.unsubscribe();
      const real = subscribe(handle.id, wrap)!;

      req.signal.addEventListener('abort', () => {
        closed = true;
        real.unsubscribe();
        try { controller.close(); } catch {}
      });
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
