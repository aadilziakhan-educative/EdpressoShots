import { NextRequest, NextResponse } from 'next/server';
import { getBlog, updateBlog, deleteBlog } from '@/lib/storage';
import { getRun } from '@/lib/runManager';

export const runtime = 'nodejs';

// GET /api/edpresso/[id] — read the full saved record from disk.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const record = await getBlog(params.id);
  if (!record) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(record);
}

// PATCH /api/edpresso/[id] — save edited HTML and/or Markdown.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const id = params.id;
  try {
    const body = await req.json();
    const { html, markdown } = body;
    const patch: Record<string, any> = {};
    if (typeof html === 'string') patch.html = html;
    if (typeof markdown === 'string') patch.markdown = markdown;
    if (!Object.keys(patch).length) {
      return NextResponse.json({ error: 'html or markdown is required' }, { status: 400 });
    }
    const updated = await updateBlog(id, patch);
    if (!updated) {
      return NextResponse.json({ error: 'Shot not found' }, { status: 404 });
    }
    // Patch in-memory run handle if still live so re-attaches get fresh content.
    const handle = getRun(id);
    if (handle) {
      if (patch.html) {
        handle.record.html = patch.html;
        const idx = handle.events.findIndex((e: any) => e?.type === 'final');
        if (idx !== -1) {
          handle.events[idx] = { ...handle.events[idx], payload: { ...handle.events[idx].payload, html: patch.html } };
        }
      }
      if (patch.markdown) {
        handle.record.markdown = patch.markdown;
        const idx = handle.events.findIndex((e: any) => e?.type === 'final');
        if (idx !== -1) {
          handle.events[idx] = { ...handle.events[idx], payload: { ...handle.events[idx].payload, markdown: patch.markdown } };
        }
      }
    }
    return NextResponse.json(patch);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Failed to save' }, { status: 500 });
  }
}

// DELETE /api/edpresso/[id] — remove the record and its generated images.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const ok = await deleteBlog(params.id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
