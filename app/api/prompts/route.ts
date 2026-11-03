import { NextResponse } from 'next/server';
import { listPrompts } from '@/lib/promptStore';
// Force registry side-effects (registerPrompt calls) by importing the wrapping module.
import '@/lib/edpressoPromptsRegistry';

export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json({ prompts: listPrompts() });
}
