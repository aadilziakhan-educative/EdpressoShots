import { NextRequest, NextResponse } from 'next/server';
import { getBlog, updateBlog } from '@/lib/storage';
import { isEducativeConfigured, parseAnswerId, pushAnswerDraft } from '@/lib/educative';

export const runtime = 'nodejs';

// POST /api/edpresso/[id]/educative — create the Answer as a draft on educative.io, or overwrite the
// draft created earlier for this Shot so edits made here reach the reviewer. Never publishes.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  if (!isEducativeConfigured()) {
    return NextResponse.json({ error: 'EDUCATIVE_FLASK_AUTH is not set in .env.local' }, { status: 400 });
  }
  const record = await getBlog(params.id);
  if (!record) return NextResponse.json({ error: 'Shot not found' }, { status: 404 });
  if (!record.markdown) return NextResponse.json({ error: 'Shot has no content yet' }, { status: 400 });

  const ed = record.edpresso || {};
  // A Shot made to replace an existing Answer always targets that Answer, even if the first push failed.
  const replaceId = parseAnswerId(record.request.existingAnswerUrl);
  try {
    const educative = await pushAnswerDraft({
      title: record.finalTitle || record.request.blogTitle,
      markdown: record.markdown,
      tags: (ed.keywords || []).slice(0, 5),
      slug: ed.slug,
      ...(replaceId ? { shotId: replaceId, replaceExisting: true } : { shotId: ed.educative?.shotId }),
    });
    const { educativeError: _dropped, ...rest } = ed;
    await updateBlog(params.id, { edpresso: { ...rest, educative } });
    return NextResponse.json({ educative });
  } catch (e: any) {
    const message = String(e?.message || e);
    await updateBlog(params.id, { edpresso: { ...ed, educativeError: message } });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
