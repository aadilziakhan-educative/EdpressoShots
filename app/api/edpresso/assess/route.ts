import { NextRequest } from 'next/server';
import { isEducativeConfigured, parseAnswerId } from '@/lib/educative';
import { assessExistingAnswer } from '@/lib/edpressoPipeline';

export const runtime = 'nodejs';
export const maxDuration = 300;

// POST /api/edpresso/assess { existingAnswerUrl } — a TL;DR verdict on whether an existing Answer
// should be revamped, judged against the generator's own guidelines.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const link = String(body?.existingAnswerUrl || '').trim();
  const shotId = parseAnswerId(link);
  if (!shotId) {
    return Response.json({ error: 'Paste the Answer\'s editor link, for example https://www.educative.io/editor/answereditor/6241014612361216' }, { status: 400 });
  }
  if (!isEducativeConfigured()) {
    return Response.json({ error: 'Checking an Answer needs EDUCATIVE_FLASK_AUTH in .env.local' }, { status: 400 });
  }
  try {
    return Response.json(await assessExistingAnswer(shotId));
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e) }, { status: 502 });
  }
}
