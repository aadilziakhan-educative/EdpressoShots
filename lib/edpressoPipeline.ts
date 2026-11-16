// Edpresso Shots (Educative Answers) pipeline.
//
//   classify ─► competitor-research ‖ link-discovery ─► link-verify ─► outline ─► writer
//     ─► reviewer (body only; re-runs once if still over the word budget; then Quiz/FAQ fact-check) ─► link-guard
//     ─► seo-meta ‖ images (plans any missing images first) ─► assemble ─► educative
//
// The writer produces code and tables itself (inside [code]/[table] tags)
// so line-by-line explanations always match the code. Only images are generated separately.
// Widgets Educative has but we cannot produce (quiz, FAQ, callout, slides, LaTeX) are emitted as
// [[X widget]] … [[/X widget]] placeholders carrying their full content. The last stage creates the
// Answer as an unpublished draft on educative.io (lib/educative.ts); a human reviewer publishes it.

import { generateText, generateTextStream, openaiSearch, openaiJSON, parseJsonLoose, TEXT_GENERATOR_MODEL, OPENAI_LIGHT } from './ai';
import {
  edpressoClassifyPrompt,
  edpressoCompetitorResearchPrompt,
  edpressoLinkDiscoveryPrompt,
  edpressoOutlinePrompt,
  edpressoWriterPrompt,
  edpressoReviewerPrompt,
  edpressoWidgetReviewPrompt,
  edpressoSeoMetaPrompt,
  edpressoImagePlanPrompt,
  edpressoCourseLinkPrompt,
  edpressoTransitionsPrompt,
} from './edpressoPromptsRegistry';
import { sanitizeText } from './transforms';
import { generateGptImage, slugify } from './imageGen';
import { getAbortSignal } from './abortContext';
import { edpressoToHtml, countBodyWords, countSegments, parseImageTag } from './edpressoAssemble';
import { isEducativeConfigured, pushAnswerDraft } from './educative';

export type StageEvent =
  | { type: 'stage'; name: string; status: 'start' | 'done' | 'error'; message?: string }
  | { type: 'data'; name: string; payload: any }
  | { type: 'log'; name?: string; message: string; payload?: any }
  | { type: 'stream'; name: string; payload: string }
  | { type: 'final'; payload: any };

export type Emit = (e: StageEvent) => void;

export type AnswerType = 'error' | 'function' | 'howto' | 'concept' | 'technology';

export interface EdpressoInput {
  title: string;
  faqs?: string;           // one question per line
  keywords?: string;       // comma- or newline-separated
  language?: string;       // empty → inferred
  answerType?: AnswerType | 'auto';
  competitorUrls?: string; // optional, one URL per line
  courseLinks?: string;    // optional Educative course URLs to link subtly, one per line (max 2)
}

interface AnswerTypeSpec {
  label: string;
  maxWords: number;
  budget: string;
  // Images every Answer of this type must have (the blog pipeline's rule: a fixed count, never optional).
  images: number;
  structure: string;
}

export const ANSWER_TYPES: Record<AnswerType, AnswerTypeSpec> = {
  error: {
    label: 'Error or troubleshooting',
    maxWords: 250,
    budget: 'under 250 words',
    images: 1,
    structure: `Target: under 250 body words. Get straight to the cause and the fix; no padding.
Order:
1. Hook: usually a one-sentence scenario in which the reader hits this error (the exact command or code and the message it prints). Then a key takeaways blockquote with 2–3 bullets.
2. "## What causes the <error>?" — a 40–60 word definition of what the error means and when it appears.
3. The situations that trigger it, as a short bulleted list (most common first), with one image showing the situation that triggers the error or how the fix changes it.
4. "## How to fix the <error>" — the fix as numbered steps with the exact command(s). Mention any risk of the fix (for example, data loss) and a safer alternative when one exists. If the fix is shell commands, add a Terminal widget placeholder with them; if it is code, show the corrected program in a runnable [code] tag.
5. Cite the official documentation for the command or setting when it is in the verified links.
6. A 1–2 sentence closing section.
7. FAQ widget.
Omit: callout quote, history, quiz, slides, and tables (unless the fix differs by version or platform). Add a Pause and think widget only if the Answer has room for it.`,
  },
  function: {
    label: 'Function or API reference',
    maxWords: 500,
    budget: 'under 500 words',
    images: 1,
    structure: `Target: under 500 body words.
Order:
1. Hook: a Callout widget with a real, relevant quote or a surprising fact, or a concrete scenario that opens the first paragraph.
2. Key takeaways blockquote with 3–4 specific bullets (never a restated parameter list).
3. "## What is <function>?" — a 40–60 word definition: what it does, what it returns, where it lives (module, class, or header), what its name stands for if it is an abbreviation, and since which version if relevant. Name the creator of the library or language in one clause when the research has it.
4. One or two sentences of motivation, tied to the hook: when a developer needs it, including the operations or scenarios that make it relevant (for example, which operations produce NaN for is_nan()).
5. "### Syntax" — the signature as a short fenced snippet (not a [code] tag, since a signature cannot run).
6. "### Parameters" — each parameter with its type and meaning (a table if there are three or more).
7. "### Return value" — the type and what each possible value means.
8. "### Example" — one runnable program in a [code] tag on the running example, covering the common case and at least one edge case, followed by a line-by-line explanation and, when it is not obvious, the expected output explained.
9. "### Points to remember" — 3–5 bullets with the gotchas readers hit (indexing base, empty or out-of-range results, errors on bad input, case sensitivity, version differences).
10. A Pause and think widget on the likeliest follow-up question; a comparison with related or sibling functions (as a table) only if it matters.
11. Quiz widget only if three meaningful questions exist (after a one-sentence lead-in), closing section, FAQ widget.`,
  },
  howto: {
    label: 'How-to with multiple methods',
    maxWords: 1000,
    budget: '500–1,000 words (never more than 1,000)',
    images: 2,
    structure: `Target: 500–1,000 body words; never over 1,000.
Order:
1. Hook: a Callout widget with a real, relevant quote or a surprising fact, or a concrete scenario that opens the first paragraph.
2. Key takeaways blockquote with 4–6 specific bullets (one per method, plus when to use which).
3. Opening tied to the hook: why and where this task matters, as a short bulleted list of named real-world applications, the primary keyword, and a short bulleted preview of the methods covered.
4. A "What is…" section with a 40–60 word definition of the underlying concept (for example, what a random number or string concatenation is), with the creator and year of the tool or language in one clause when the research has it.
5. One section per method, headed "Method N: <method>" or "N. <Action> using <method>", ordered from the most common or simplest to the most specialized. Every method uses the same running example. For each: one or two sentences on what it is and when to use it (naming the line that does the work), numbered steps if setup is needed, a runnable [code] tag with a unique keyword-rich caption, a line-by-line explanation of the key lines, and 1–2 "Pros:" and "Cons:" bullets. Add a Note blockquote for gotchas (thread safety, type conversion, security).
6. A Pause and think widget after the method that raises the likeliest question.
7. A comparison table of all methods (use case, strengths, limitations or performance) with a title, followed by a short "how to choose" section. When methods give different results on some input, include one short program that runs them on that input and prints the difference.
8. For command-line or installation tasks, a Terminal widget placeholder with the commands to try.
9. Quiz widget (after a one-sentence lead-in), closing section, FAQ widget.`,
  },
  concept: {
    label: 'Concept or algorithm',
    maxWords: 1000,
    budget: 'up to 1,000 words (as short as the concept allows)',
    images: 2,
    structure: `Target: as short as the concept allows; at most 1,000 body words.
Order:
1. Hook: a Callout widget with a real, relevant quote or a surprising fact, or a concrete scenario that opens the first paragraph.
2. Key takeaways blockquote with 4–6 specific bullets.
3. "## What is <concept>?" — a 40–60 word definition, then history (who introduced it and when) if relevant, and what the name stands for if it is an abbreviation.
4. Motivation tied to the hook: why it matters and where it is used in the real world (named applications, companies, or fields).
5. The problem it solves, with a concrete example using real values.
6. How it works: a step-by-step walkthrough (dry run) on the concrete example. Illustrate the walkthrough with images (a Slides widget placeholder may hold any further steps).
7. Formulas or complexity (Big O) in a LaTeX widget placeholder or inline, with an explanation of where they come from.
8. Code: the bigger picture first, then a runnable [code] tag on the same example as the walkthrough, then a line-by-line explanation. A Pause and think widget after the walkthrough or the code, on the likeliest confusion.
9. When the title compares related concepts, give each its own "What is…" subsection and end with a comparison table.
10. Applications and popular libraries or tools that implement it.
11. Quiz widget (after a one-sentence lead-in), closing section, FAQ widget.`,
  },
  technology: {
    label: 'Technology or framework',
    maxWords: 1000,
    budget: 'up to 1,000 words',
    images: 2,
    structure: `Target: at most 1,000 body words.
Order:
1. Hook: a Callout widget with a quote from the creator or a well-known user, or a surprising fact, or a concrete scenario that opens the first paragraph.
2. Key takeaways blockquote with 4–6 specific bullets.
3. "## What is <technology>?" — a 40–60 word definition first (for the featured snippet), then a short history: creator, year, and how it evolved.
4. Why it matters: the problem it solves, adoption numbers, and well-known companies or products that use it (only facts from the research).
5. Key features in logical order (foundational features first, dependent features after; most important first), each with a one or two sentence explanation.
6. A "Hello World" or minimal example in a runnable [code] tag, with an explanation; for command-line tools, also an options table and a Terminal widget placeholder with commands to try.
7. Common use cases, then a Pause and think widget on the likeliest follow-up question.
8. Strengths and limitations (a table works well), plus ecosystem, deprecation, or version notes where relevant.
9. Quiz widget (after a one-sentence lead-in), closing section, FAQ widget.`,
  },
};

const INTERNAL_HOSTS = ['educative.io', 'how.dev'];
// E-learning competitors and low-authority sites we never link to (the slides: "never link to
// competitors"). Domains from the author's competitor URLs are added per run.
const BLOCKED_HOSTS = [
  'geeksforgeeks.org', 'w3schools.com', 'programiz.com', 'tutorialspoint.com', 'javatpoint.com',
  'freecodecamp.org', 'baeldung.com', 'realpython.com', 'medium.com', 'dev.to', 'udemy.com',
  'coursera.org', 'codecademy.com', 'datacamp.com', 'scaler.com', 'simplilearn.com',
  'stackoverflow.com', 'stackexchange.com', 'quora.com', 'reddit.com', 'bytebytego.com',
  'designgurus.io', 'hellointerview.com', 'interviewbit.com', 'leetcode.com', 'hackerrank.com',
  'digitalocean.com', 'guru99.com', 'beginnersbook.com', 'studytonight.com', 'scaler.in',
];
const MAX_LINK_CANDIDATES = 30;
export const MAX_COURSE_LINKS = 2;
const LINK_TIMEOUT_MS = 12_000;
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export interface VerifiedLink { url: string; finalUrl: string; title: string; topic: string; kind: 'internal' | 'external' }

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function hostMatches(host: string, domains: string[]): boolean {
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

// Search models append tracking parameters (e.g. ?utm_source=openai) to cited URLs; never let them into an Answer.
function stripTracking(url: string): string {
  try {
    const u = new URL(url.trim());
    for (const key of [...u.searchParams.keys()]) if (/^utm_/i.test(key)) u.searchParams.delete(key);
    return u.toString();
  } catch {
    return url.trim();
  }
}

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    const pathname = u.pathname.replace(/\/+$/, '') || '/';
    return `https://${u.hostname.toLowerCase().replace(/^www\./, '')}${pathname}${u.search}`;
  } catch {
    return url.trim();
  }
}

function linkSignal(): AbortSignal {
  const run = getAbortSignal();
  const timeout = AbortSignal.timeout(LINK_TIMEOUT_MS);
  return run ? AbortSignal.any([run, timeout]) : timeout;
}

async function checkUrl(url: string, attempt = 1): Promise<{ ok: boolean; status: number; finalUrl: string }> {
  let result: { ok: boolean; status: number; finalUrl: string };
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' }, signal: linkSignal() });
    res.body?.cancel().catch(() => {});
    result = { ok: res.ok, status: res.status, finalUrl: res.url || url };
  } catch (e: any) {
    if (getAbortSignal()?.aborted) throw e;
    result = { ok: false, status: 0, finalUrl: url };
  }
  // Retry once on transient failures (network error, rate limit, server error); a 404 is final.
  const transient = result.status === 0 || result.status === 429 || result.status >= 500;
  return !result.ok && transient && attempt === 1 ? checkUrl(url, 2) : result;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

function formatVerifiedLinks(links: VerifiedLink[]): string {
  if (!links.length) return '(none — write no links)';
  const internal = links.filter((l) => l.kind === 'internal');
  const external = links.filter((l) => l.kind === 'external');
  const line = (l: VerifiedLink) => `- ${l.url} — ${l.title || l.topic}${l.topic && l.title ? ` (explains: ${l.topic})` : ''}`;
  return [
    'Internal (Educative and how.dev — prefer these):',
    ...(internal.length ? internal.map(line) : ['- (none)']),
    '',
    'External (official sources — use only to back facts, quotes, or documentation):',
    ...(external.length ? external.map(line) : ['- (none)']),
  ].join('\n');
}

// Replace any Markdown or HTML link whose URL was not verified with its anchor text.
export function stripUnverifiedLinks(markdown: string, allowed: Set<string>): { markdown: string; removed: string[] } {
  const removed: string[] = [];
  let out = markdown.replace(/(!?)\[([^\]]*)\]\(\s*(https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\s*\)/g, (m, bang, text, url) => {
    if (bang) return m; // images are handled separately
    const clean = stripTracking(url);
    if (allowed.has(normalizeUrl(clean))) return `[${text}](${clean})`;
    removed.push(url);
    return text;
  });
  out = out.replace(/<a\b[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, url, text) => {
    if (allowed.has(normalizeUrl(stripTracking(url)))) return m;
    removed.push(url);
    return text;
  });
  return { markdown: out, removed };
}

function toList(s: string | undefined, separator: RegExp = /\r?\n|,/): string[] {
  return String(s || '').split(separator).map((x) => x.trim()).filter(Boolean);
}

function normalizeImageTags(md: string): string {
  return md.replace(/(\[image\][\s\S]*?\[\/Caption\])(?!\s*\[\/image\])/gi, '$1[/image]');
}

// A rewrite is accepted only if it kept the Answer intact: similar length and every code and image tag.
function isSafeRewrite(before: string, after: string): boolean {
  if (!after || after.length < before.length * 0.5) return false;
  const tagCount = (s: string, tag: string) => (s.match(new RegExp(`\\[${tag}\\]`, 'g')) || []).length;
  return tagCount(after, 'code') >= tagCount(before, 'code') && tagCount(after, 'image') >= tagCount(before, 'image');
}

const IMAGE_TAG_RE = /\[image\]([\s\S]*?)\[\/image\]/g;

// Classify each line as a "##"/"###" heading, plain prose, a list item, a block line, or other (blank,
// blockquote, table row). Lines of code fences, [code]/[table]/[image] tags, and [[… widget]]
// placeholders are "block", so a "## comment" in code is never a heading and code is never edited.
function classifyLines(lines: string[]): ('heading' | 'prose' | 'list' | 'block' | 'other')[] {
  let closer: RegExp | null = null;
  return lines.map((l) => {
    if (closer) {
      if (closer.test(l)) closer = null;
      return 'block';
    }
    if (/^\s*EDPWIDGET\d+TOKEN\s*$/.test(l)) return 'block';
    const open = l.match(/^\s*(```|\[(code|table|image)\]|\[\[([A-Za-z][A-Za-z ]*?) widget\]\])/);
    if (open) {
      const close = open[1] === '```' ? /^\s*```/ : open[2] ? new RegExp(`\\[\\/${open[2]}\\]`) : new RegExp(`\\[\\[\\/${open[3]} widget\\]\\]`);
      if (!close.test(l.slice(open.index! + open[0].length))) closer = close;
      return 'block';
    }
    if (/^#{2,3}\s/.test(l)) return 'heading';
    if (/^\s*([-*]\s|\d+\.\s)/.test(l)) return 'list';
    return l.trim() && !/^\s*([>|[]|\*\s)/.test(l) ? 'prose' : 'other';
  });
}

function sectionHeadings(md: string): { heading: string; hasImage: boolean }[] {
  const lines = md.split('\n');
  const kinds = classifyLines(lines);
  const out: { heading: string; hasImage: boolean }[] = [];
  lines.forEach((l, i) => {
    if (kinds[i] === 'heading') out.push({ heading: l.replace(/^#+\s*/, '').trim(), hasImage: false });
    else if (out.length && /^\s*\[image\]/.test(l)) out[out.length - 1].hasImage = true;
  });
  return out;
}

// Insert an image tag after the first paragraph of the section with this heading (or at the end of the
// section when it has no plain paragraph). Returns null when the heading is not found.
function insertImageInSection(md: string, heading: string, tag: string): string | null {
  const lines = md.split('\n');
  const kinds = classifyLines(lines);
  const norm = (h: string) => h.replace(/^#+\s*/, '').trim().toLowerCase();
  const start = lines.findIndex((l, i) => kinds[i] === 'heading' && norm(l) === norm(heading));
  if (start === -1) return null;
  let end = kinds.findIndex((k, i) => i > start && k === 'heading');
  if (end === -1) end = lines.length;
  let at = end;
  for (let i = start + 1; i < end; i++) {
    if (kinds[i] === 'prose' && !lines[i + 1]?.trim()) { at = i + 1; break; }
  }
  lines.splice(at, 0, '', tag, '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

// ---- Course links: optional Educative course URLs woven into the body as ordinary anchors. ----

// Wording that turns a link into an advert. A course link must never sit in a sentence like this.
// "the path" or "the resource" alone are normal technical wording, so only pointing words count.
const EXPLICIT_CTA_RE = /\b(this|these|our|the following)\s+([\w-]+\s+)?(course|courses|path|paths|skill path|learning path|resource|resources|tutorial)\b|(?<!\bof )\bcourses?\b|\b(learn more|check out|have a look|take a look|enroll|sign up|start learning|you can explore)\b|\b(covered|taught|explained|discussed|explored|introduced|described)\s+(in|by)\b/i;

// An anchor that names the course ("learn Python", "Grokking Dynamic Programming") points at it.
function isCourseNameAnchor(anchor: string, url: string): boolean {
  const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim();
  const a = words(anchor);
  return /^(learn|master|explore|grokking|mastering|become)\b/.test(a) || a === words(courseTopic(url));
}

// True when the offset falls inside a "#key# term: definition #key#" keyword popup.
function insideKeyPopup(line: string, offset: number): boolean {
  return (line.slice(0, offset).match(/#key#/g) || []).length % 2 === 1;
}

// Next to a course link, these verbs point the reader at the course ("see [grouping patterns](…)").
const POINTER_RE = /\b(see|visit|refer to|head over to|explore)\b/i;

function isAdvert(sentence: string, anchor: string, url: string): boolean {
  return EXPLICIT_CTA_RE.test(sentence.replace(MD_LINK_RE, '$2')) || POINTER_RE.test(sentence.replace(MD_LINK_RE, '$2')) || isCourseNameAnchor(anchor, url);
}

const isCoursePage = (url: string) => {
  try {
    const u = new URL(url);
    return hostMatches(u.hostname.toLowerCase(), ['educative.io']) && /^\/(courses|path|paths|skill-paths)\//.test(u.pathname);
  } catch {
    return false;
  }
};

// Course or path pages the pipeline found itself follow the same rule as the author's course links:
// a sentence that points the reader at one is deleted.
function removeCoursePointers(md: string, skipUrls: string[]): { markdown: string; removed: string[] } {
  const skip = new Set(skipUrls.map((u) => normalizeUrl(stripTracking(u))));
  const lines = md.split('\n');
  const kinds = classifyLines(lines);
  const removed: string[] = [];
  const out = lines.map((line, i) => {
    if (kinds[i] !== 'prose' && kinds[i] !== 'list') return line;
    let l = line;
    for (const m of [...line.matchAll(MD_LINK_RE)]) {
      const href = m[3];
      if (m[1] || !isCoursePage(href) || skip.has(normalizeUrl(stripTracking(href)))) continue;
      const sentence = sentenceAround(line, m.index!);
      if (isAdvert(sentence, m[2], href) && l.includes(sentence)) {
        l = l.replace(sentence, '').replace(/[ \t]{2,}/g, ' ').trimEnd();
        removed.push(sentence);
      }
    }
    return l;
  });
  return { markdown: out.join('\n'), removed };
}

const MD_LINK_RE = /(!?)\[([^\]]*)\]\(\s*(https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

function courseTopic(url: string): string {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return (parts[parts.length - 1] || '').replace(/-/g, ' ');
  } catch {
    return '';
  }
}

function formatCourseLinks(urls: string[]): string {
  if (!urls.length) return '(none — write no course links)';
  return urls.map((u) => `- ${u} (teaches: ${courseTopic(u)})`).join('\n');
}

function sentenceAround(line: string, index: number): string {
  const starts = [0, ...[...line.matchAll(/[.!?]["')\]]?\s+(?=[A-Z`*\[#])/g)].map((m) => m.index! + m[0].length)];
  const start = Math.max(...starts.filter((i) => i <= index));
  const next = starts.find((i) => i > index);
  return line.slice(start, next ?? line.length).trim();
}

interface CourseLinkStatus { url: string; status: 'linked' | 'missing'; anchor?: string; sentence?: string; explicit?: boolean }

// Keeps the first well-placed link to each course URL (body prose or a list item, not in a heading,
// blockquote, code, or widget), unlinks every other occurrence, and reports each course link's state.
function auditCourseLinks(md: string, courseUrls: string[]): { markdown: string; links: CourseLinkStatus[] } {
  const keyOf = (u: string) => normalizeUrl(stripTracking(u));
  const wanted = new Map(courseUrls.map((u) => [keyOf(u), u]));
  const kept = new Map<string, CourseLinkStatus>();
  const lines = md.split('\n');
  const kinds = classifyLines(lines);
  const out = lines.map((line, i) => line.replace(MD_LINK_RE, (m, bang, text, href, offset) => {
    const url = wanted.get(keyOf(href));
    if (bang || !url || kinds[i] === 'block') return m;
    const placeable = (kinds[i] === 'prose' || kinds[i] === 'list') && !insideKeyPopup(line, offset);
    if (!placeable || kept.has(url)) return text;
    const sentence = sentenceAround(line, offset);
    kept.set(url, { url, status: 'linked', anchor: text, sentence, explicit: isAdvert(sentence, text, url) });
    return `[${text}](${url})`;
  }));
  return {
    markdown: out.join('\n'),
    links: courseUrls.map((u) => kept.get(u) || { url: u, status: 'missing' as const }),
  };
}

// Sentences a course link may be placed in: body prose or list items without keyword popups, links,
// or advert wording. Positions are kept so the link is inserted exactly where the words are.
function linkableSentences(md: string): { line: number; start: number; text: string }[] {
  const lines = md.split('\n');
  const kinds = classifyLines(lines);
  const out: { line: number; start: number; text: string }[] = [];
  lines.forEach((line, i) => {
    if (kinds[i] !== 'prose' && kinds[i] !== 'list') return;
    const starts = [0, ...[...line.matchAll(/[.!?]["')\]]?\s+(?=[A-Z`*\[#])/g)].map((m) => m.index! + m[0].length), line.length];
    for (let k = 0; k < starts.length - 1; k++) {
      const text = line.slice(starts[k], starts[k + 1]).trimEnd();
      if (text.split(/\s+/).length < 6 || /#key#|\]\(/.test(text) || EXPLICIT_CTA_RE.test(text) || POINTER_RE.test(text)) continue;
      out.push({ line: i, start: starts[k], text });
    }
  });
  return out;
}

// Links the first occurrence of `anchor` in the sentence, only when it is one to five words that sit
// outside inline code and bold markers and do not name the course.
function placeCourseLink(md: string, s: { line: number; start: number; text: string }, anchor: string, url: string): string | null {
  const a = anchor.trim();
  if (!a || a.split(/\s+/).length > 5 || isCourseNameAnchor(a, url)) return null;
  const at = s.text.indexOf(a);
  if (at === -1) return null;
  const before = s.text.slice(0, at);
  if ((before.match(/`/g) || []).length % 2 === 1 || /[`*]/.test(a)) return null;
  const lines = md.split('\n');
  const pos = s.start + at;
  lines[s.line] = `${lines[s.line].slice(0, pos)}[${a}](${url})${lines[s.line].slice(pos + a.length)}`;
  return lines.join('\n');
}

// Makes every course link appear exactly once, subtly, in the Answer body. Sentences that advertise a
// course are deleted (they teach nothing); each course left unlinked is then placed on existing words of
// a numbered candidate sentence the model picks, so no sentence is ever rewritten.
export async function weaveCourseLinks(md: string, courseUrls: string[], title: string): Promise<{
  markdown: string; links: CourseLinkStatus[]; removedSentences: string[]; applied: any[]; prompt?: string; picks?: any[];
}> {
  let audit = auditCourseLinks(md, courseUrls);
  const removedSentences: string[] = [];
  let d = audit.markdown;
  for (const l of audit.links.filter((x) => x.explicit && x.sentence)) {
    d = d.replace(l.sentence!, '').replace(/[ \t]{2,}/g, ' ').replace(/ +$/gm, '');
    removedSentences.push(l.sentence!);
  }
  audit = auditCourseLinks(d, courseUrls);
  const missing = audit.links.filter((l) => l.status === 'missing');
  const applied: any[] = [];
  const candidates = linkableSentences(audit.markdown);
  if (!missing.length || !candidates.length) return { markdown: audit.markdown, links: audit.links, removedSentences, applied };

  const prompt = edpressoCourseLinkPrompt({
    title,
    tasks: missing.map((l) => `- ${l.url} (teaches: ${courseTopic(l.url)})`).join('\n'),
    sentences: candidates.map((c, i) => `${i + 1}. ${c.text}`).join('\n'),
  });
  let picks: any[] = [];
  try {
    // The default model: choosing words that relate to the course is a judgement call.
    const parsed: any = parseJsonLoose(await openaiJSON(prompt));
    picks = Array.isArray(parsed?.links) ? parsed.links : [];
  } catch (e: any) {
    if (getAbortSignal()?.aborted) throw e;
  }
  d = audit.markdown;
  const used = new Set<number>();
  for (const l of missing) {
    const pick = picks.find((p) => normalizeUrl(String(p?.url || '')) === normalizeUrl(l.url));
    const n = Number(pick?.sentence) - 1;
    if (!pick || !candidates[n] || used.has(candidates[n].line)) continue;
    const next = placeCourseLink(d, candidates[n], String(pick.anchor || ''), l.url);
    if (next) { d = next; used.add(candidates[n].line); applied.push({ url: l.url, sentence: candidates[n].text, anchor: pick.anchor }); }
  }
  audit = auditCourseLinks(d, courseUrls);
  return { markdown: audit.markdown, links: audit.links, removedSentences, applied, prompt, picks };
}

// The Quiz and FAQ widgets are not part of the word budget, so the reviewer never sees them: it
// would trim FAQs to save words. Each is swapped for an EDPWIDGET<n>TOKEN line that keeps its place
// (the Quiz sits before the closing section, the FAQ at the end) and is swapped back afterwards.
const PROTECTED_WIDGET_RE = /\[\[(Quiz|FAQ) widget\]\][\s\S]*?\[\[\/\1 widget\]\]/g;
function protectWidgets(md: string): { body: string; blocks: string[] } {
  const blocks: string[] = [];
  const body = md.replace(PROTECTED_WIDGET_RE, (m) => `\n\nEDPWIDGET${blocks.push(m) - 1}TOKEN\n\n`);
  return { body: body.replace(/\n{3,}/g, '\n\n').trim(), blocks };
}

// Puts protected widgets back at their tokens. A token the reviewer dropped falls back to the
// standard place: a Quiz before the closing ("##") section, anything else at the end.
function restoreWidgets(body: string, blocks: string[]): string {
  let out = body;
  blocks.forEach((block, i) => {
    const token = `EDPWIDGET${i}TOKEN`;
    if (out.includes(token)) { out = out.replace(token, block); return; }
    const lines = out.split('\n');
    const kinds = classifyLines(lines);
    const closing = /^\[\[Quiz widget\]\]/.test(block) ? lines.map((l, j) => (kinds[j] === 'heading' && /^##\s/.test(l) ? j : -1)).filter((j) => j >= 0).pop() : undefined;
    if (closing !== undefined) { lines.splice(closing, 0, block, ''); out = lines.join('\n'); }
    else out = `${out}\n\n${block}`;
  });
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

// ---- Transitions: two interactive elements (code, table, image, snippet, widget) never sit back to back. ----

const ELEMENT_RE = /\[(code|table|image)\][\s\S]*?\[\/\1\]|\[\[([A-Za-z][A-Za-z ]*?) widget\]\][\s\S]*?\[\[\/\2 widget\]\]/g;

function elementSpans(md: string): { start: number; end: number; kind: string; text: string }[] {
  const spans: { start: number; end: number; kind: string; text: string }[] = [];
  for (const m of md.matchAll(ELEMENT_RE)) spans.push({ start: m.index!, end: m.index! + m[0].length, kind: m[1] || `${m[2]} widget`, text: m[0] });
  const inside = (i: number) => spans.some((s) => i >= s.start && i < s.end);
  for (const m of md.matchAll(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm)) {
    if (!inside(m.index!)) spans.push({ start: m.index!, end: m.index! + m[0].length, kind: 'code snippet', text: m[0] });
  }
  return spans.sort((a, b) => a.start - b.start);
}

// Text between two elements counts only if it has a real sentence: headings, labels such as "Output:",
// and blank lines do not.
function hasBridgingText(gap: string): boolean {
  return gap.split('\n').some((l) => !/^\s*#/.test(l) && l.replace(/^[\s>*-]+/, '').split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length >= 4);
}

export async function addTransitions(md: string, title: string): Promise<{ markdown: string; added: { before: string; sentence: string }[]; prompt?: string }> {
  const spans = elementSpans(md);
  const gaps: { at: number; before: typeof spans[number]; after: typeof spans[number]; heading: string }[] = [];
  for (let i = 1; i < spans.length; i++) {
    const a = spans[i - 1], b = spans[i];
    if (b.start < a.end || hasBridgingText(md.slice(a.end, b.start))) continue;
    const heading = [...md.slice(0, b.start).matchAll(/^#{2,3}\s+(.+)$/gm)].pop()?.[1] || title;
    gaps.push({ at: b.start, before: a, after: b, heading });
  }
  if (!gaps.length) return { markdown: md, added: [] };
  const describe = (s: typeof spans[number]) => `${s.kind}: ${s.text.replace(/\s+/g, ' ').slice(0, 300)}`;
  const prompt = edpressoTransitionsPrompt({
    title,
    gaps: gaps.map((g, i) => `${i + 1}. Section "${g.heading}"\n   Before: ${describe(g.before)}\n   After: ${describe(g.after)}`).join('\n\n'),
  });
  let sentences: any[] = [];
  try {
    const parsed: any = parseJsonLoose(await openaiJSON(prompt, OPENAI_LIGHT));
    sentences = Array.isArray(parsed?.sentences) ? parsed.sentences : [];
  } catch (e: any) {
    if (getAbortSignal()?.aborted) throw e;
  }
  let out = md;
  const added: { before: string; sentence: string }[] = [];
  // Insert from the last gap backwards so earlier offsets stay valid.
  for (let i = gaps.length - 1; i >= 0; i--) {
    const text = String(sentences.find((x) => Number(x?.gap) === i + 1)?.text || '').trim();
    const words = text.split(/\s+/).length;
    if (!text || words < 4 || words > 40 || /\]\(|https?:/.test(text) || EXPLICIT_CTA_RE.test(text)) continue;
    out = `${out.slice(0, gaps[i].at)}${text}\n\n${out.slice(gaps[i].at)}`;
    added.unshift({ before: gaps[i].after.kind, sentence: text });
  }
  return { markdown: out, added, prompt };
}

function faqQuestions(md: string): string[] {
  return (md.match(/\[\[FAQ widget\]\]([\s\S]*?)\[\[\/FAQ widget\]\]/)?.[1] || '')
    .split('\n').filter((l) => /^\s*Q:/.test(l)).map((l) => l.replace(/^\s*Q:\s*/, '').trim());
}

const normQuestion = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export async function runEdpressoPipeline(input: EdpressoInput, emit: Emit): Promise<any> {
  const title = input.title.trim();
  const keywords = toList(input.keywords);
  const userFaqs = toList(input.faqs, /\r?\n/).map((q) => q.replace(/^[-*\d.)\s]+/, '').trim()).filter(Boolean);
  const competitorUrls = toList(input.competitorUrls).filter((u) => /^https?:\/\//i.test(u));
  const courseLinkInputs = [...new Set(toList(input.courseLinks)
    .map((u) => stripTracking(u))
    .filter((u) => /^https?:\/\//i.test(u) && hostMatches(hostOf(u), ['educative.io'])))]
    .slice(0, MAX_COURSE_LINKS);
  const keywordsStr = keywords.join(', ') || title;

  const stageLog = (name: string, prompt: string, inputs: any, output: any) => {
    const entry = { stage: name, prompt, input: inputs, output };
    try {
      console.log(
        `\n========= [edpresso:${name}] =========\n` +
          `--- prompt (first 400 chars) ---\n${String(prompt).slice(0, 400)}\n` +
          `--- output (first 400 chars) ---\n${typeof output === 'string' ? output.slice(0, 400) : JSON.stringify(output).slice(0, 800)}\n` +
          `=========`,
      );
    } catch {}
    emit({ type: 'log', name, message: `stage:${name}`, payload: entry });
  };
  const stage = async <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
    emit({ type: 'stage', name, status: 'start' });
    try {
      const result = await fn();
      emit({ type: 'stage', name, status: 'done' });
      return result;
    } catch (e: any) {
      emit({ type: 'stage', name, status: 'error', message: String(e?.message || e) });
      throw e;
    }
  };
  console.log(`[edpresso] starting | title=${title} | type=${input.answerType || 'auto'} | lang=${input.language || 'auto'}`);

  // 1) Classify — Answer type, language, primary keyword.
  const classified = await stage('classify', async () => {
    const prompt = edpressoClassifyPrompt({ title, keywords: keywordsStr, requestedLanguage: input.language || '' });
    const raw = await openaiJSON(prompt, OPENAI_LIGHT);
    let parsed: any = {};
    try { parsed = parseJsonLoose(raw); } catch {}
    const detected = (parsed.answerType in ANSWER_TYPES ? parsed.answerType : 'concept') as AnswerType;
    const answerType: AnswerType = input.answerType && input.answerType !== 'auto' ? input.answerType : detected;
    const language = (input.language || parsed.language || 'none').trim().toLowerCase();
    const result = { answerType, detectedType: detected, language, primaryKeyword: parsed.primaryKeyword || keywords[0] || title, reason: parsed.reason || '' };
    stageLog('classify', prompt, { title, keywords: keywordsStr }, result);
    emit({ type: 'data', name: 'classify', payload: result });
    return result;
  });
  const spec = ANSWER_TYPES[classified.answerType];
  const imageCountStr = `${spec.images} image${spec.images === 1 ? '' : 's'}`;
  const languageStr = classified.language === 'none' ? 'none (use code only if it is essential)' : classified.language;

  // 2) Competitor research ‖ link discovery (both web search).
  const [research, linkCandidates] = await Promise.all([
    stage('competitor-research', async () => {
      const prompt = edpressoCompetitorResearchPrompt({
        title, keywords: keywordsStr, language: languageStr, answerTypeLabel: spec.label,
        competitorUrls: competitorUrls.length ? competitorUrls.map((u) => `- ${u}`).join('\n') : '(none)',
      });
      const out = await openaiSearch(prompt);
      stageLog('competitor-research', prompt, { title, competitorUrls }, out);
      emit({ type: 'data', name: 'competitor-research', payload: out });
      return out;
    }),
    stage('link-discovery', async () => {
      const prompt = edpressoLinkDiscoveryPrompt({ title, keywords: keywordsStr, language: languageStr });
      // The search model occasionally answers in prose or returns an empty list, so parse
      // tolerantly, fall back to scraping Educative URLs from the text, and retry once if empty.
      let result: { internal: any[]; external: any[] } = { internal: [], external: [] };
      for (let attempt = 1; attempt <= 2 && !result.internal.length; attempt++) {
        const out = await openaiSearch(prompt);
        let parsed: any = {};
        try { parsed = parseJsonLoose(out); } catch {}
        result = {
          internal: Array.isArray(parsed.internal) ? parsed.internal : [],
          external: Array.isArray(parsed.external) ? parsed.external : [],
        };
        if (!result.internal.length) {
          for (const m of out.matchAll(/https?:\/\/[^\s)\]>"',]+/g)) {
            if (hostMatches(hostOf(m[0]), INTERNAL_HOSTS)) result.internal.push({ url: m[0] });
          }
        }
        stageLog(`link-discovery#${attempt}`, prompt, { title }, out);
      }
      emit({ type: 'data', name: 'link-discovery', payload: result });
      return result;
    }),
  ]);

  // 3) Link verification — every candidate must load (HTTP 2xx after redirects).
  const { verifiedLinks, rejectedLinks, courseLinks } = await stage('link-verify', async () => {
    const blocked = [...BLOCKED_HOSTS, ...competitorUrls.map(hostOf).filter(Boolean)];
    const seen = new Set<string>();
    const candidates: { url: string; title: string; topic: string }[] = [];
    const add = (c: any) => {
      const url = stripTracking(String(c?.url || '').trim().replace(/[).,;]+$/, ''));
      if (!/^https?:\/\//i.test(url)) return;
      const key = normalizeUrl(url);
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({ url, title: String(c?.title || ''), topic: String(c?.topic || '') });
    };
    linkCandidates.internal.forEach(add);
    linkCandidates.external.forEach(add);
    // Educative pages cited in the research brief are candidates too. External URLs from the brief are
    // not: search results include low-authority tutorial sites, so external links come only from
    // link-discovery, which is restricted to official sources.
    for (const m of String(research).matchAll(/https?:\/\/[^\s)\]>"']+/g)) {
      if (hostMatches(hostOf(m[0]), INTERNAL_HOSTS)) add({ url: m[0] });
    }

    const rejected: { url: string; reason: string }[] = [];
    const toCheck = candidates.filter((c) => {
      const host = hostOf(c.url);
      if (hostMatches(host, INTERNAL_HOSTS)) return true;
      if (hostMatches(host, blocked)) { rejected.push({ url: c.url, reason: 'competitor or low-authority site' }); return false; }
      return true;
    }).slice(0, MAX_LINK_CANDIDATES);

    const [results, courseResults] = await Promise.all([
      mapLimit(toCheck, 6, async (c) => ({ c, r: await checkUrl(c.url) })),
      mapLimit(courseLinkInputs, 2, async (url) => ({ url, r: await checkUrl(url) })),
    ]);
    const courses: string[] = [];
    for (const { url, r } of courseResults) {
      if (r.ok) courses.push(url);
      else rejected.push({ url, reason: `course link ${r.status ? `HTTP ${r.status}` : 'unreachable'}` });
    }
    const verified: VerifiedLink[] = [];
    for (const { c, r } of results) {
      if (!r.ok) { rejected.push({ url: c.url, reason: r.status ? `HTTP ${r.status}` : 'unreachable' }); continue; }
      // A redirect to a site's home page usually means the page is gone.
      const finalPath = (() => { try { return new URL(r.finalUrl).pathname.replace(/\/+$/, ''); } catch { return ''; } })();
      const askedPath = (() => { try { return new URL(c.url).pathname.replace(/\/+$/, ''); } catch { return ''; } })();
      if (askedPath && !finalPath) { rejected.push({ url: c.url, reason: 'redirected to home page' }); continue; }
      const kind = hostMatches(hostOf(c.url), INTERNAL_HOSTS) || hostMatches(hostOf(r.finalUrl), INTERNAL_HOSTS) ? 'internal' : 'external';
      verified.push({ url: c.url, finalUrl: r.finalUrl, title: c.title, topic: c.topic, kind });
    }
    const payload = { verified, rejected, courseLinks: courses };
    stageLog('link-verify', '(HTTP GET each candidate, follow redirects, keep 2xx)', { candidates: candidates.length, checked: toCheck.length }, payload);
    emit({ type: 'data', name: 'link-verify', payload });
    return { verifiedLinks: verified, rejectedLinks: rejected, courseLinks: courses };
  });
  const verifiedLinksStr = formatVerifiedLinks(verifiedLinks);
  const courseLinksStr = formatCourseLinks(courseLinks);
  const allowedUrls = new Set<string>([
    ...verifiedLinks.flatMap((l) => [normalizeUrl(l.url), normalizeUrl(l.finalUrl)]),
    ...courseLinks.map(normalizeUrl),
  ]);

  // 4) Outline.
  const outline = await stage('outline', async () => {
    const args = {
      title, answerTypeLabel: spec.label, wordBudget: spec.budget, typeStructure: spec.structure,
      language: languageStr, keywords: keywordsStr,
      userFaqs: userFaqs.length ? userFaqs.map((q) => `- ${q}`).join('\n') : '(none provided — take all FAQs from People also ask)',
      research, verifiedLinks: verifiedLinksStr, imageCount: imageCountStr,
    };
    const prompt = edpressoOutlinePrompt(args);
    const raw = await openaiJSON(prompt);
    let parsed: any;
    try { parsed = parseJsonLoose(raw); } catch { parsed = { raw }; }
    stageLog('outline', prompt, { title, answerType: classified.answerType }, parsed);
    emit({ type: 'data', name: 'outline', payload: parsed });
    return parsed;
  });

  // 5) Writer (streamed).
  let draft = await stage('writer', async () => {
    const prompt = edpressoWriterPrompt({
      title, answerTypeLabel: spec.label, wordBudget: spec.budget, typeStructure: spec.structure,
      language: languageStr, keywords: keywordsStr, outline: JSON.stringify(outline, null, 2),
      research, verifiedLinks: verifiedLinksStr, imageCount: imageCountStr, courseLinks: courseLinksStr,
    });
    let lastStreamAt = 0;
    const out = await generateTextStream(
      prompt,
      (_chunk, accumulated) => {
        const now = Date.now();
        if (now - lastStreamAt < 30) return;
        lastStreamAt = now;
        emit({ type: 'stream', name: 'writer', payload: accumulated });
      },
      { maxTokens: 16000, model: TEXT_GENERATOR_MODEL },
    );
    emit({ type: 'stream', name: 'writer', payload: out });
    stageLog('writer', prompt, { title }, out);
    const cleaned = normalizeImageTags(sanitizeText(out)).trim();
    emit({ type: 'data', name: 'writer', payload: cleaned });
    return cleaned;
  });

  // 6) Reviewer — checklist pass; one extra tightening pass if still >10% over budget.
  draft = await stage('reviewer', async () => {
    const { body, blocks } = protectWidgets(draft);
    let d = body;
    const passes: { pass: number; wordsBefore: number; wordsAfter: number; accepted: boolean }[] = [];
    for (let pass = 1; pass <= 2; pass++) {
      const wordsBefore = countBodyWords(d);
      if (pass === 2 && wordsBefore <= spec.maxWords * 1.1) break;
      const prompt = edpressoReviewerPrompt({
        title, answerTypeLabel: spec.label, wordBudget: spec.budget, currentWordCount: String(wordsBefore),
        typeStructure: spec.structure, keywords: keywordsStr, verifiedLinks: verifiedLinksStr, courseLinks: courseLinksStr, draft: d,
      });
      const out = normalizeImageTags(sanitizeText(await generateText(prompt, { maxTokens: 16000 }))).trim();
      const accepted = isSafeRewrite(d, out);
      if (accepted) d = out;
      passes.push({ pass, wordsBefore, wordsAfter: countBodyWords(d), accepted });
      stageLog(`reviewer#${pass}`, prompt, { wordsBefore, budget: spec.maxWords }, out);
    }
    // Fact-check the Quiz and FAQ separately; accept only if every question survived unchanged.
    const tail = blocks.join('\n\n');
    let checkedBlocks = blocks;
    if (tail) {
      const prompt = edpressoWidgetReviewPrompt({ title, language: languageStr, keywords: keywordsStr, verifiedLinks: verifiedLinksStr, widgets: tail });
      const out = normalizeImageTags(sanitizeText(await generateText(prompt, { maxTokens: 8000 }))).trim();
      const sameFaqs = faqQuestions(out).map(normQuestion).join('|') === faqQuestions(tail).map(normQuestion).join('|');
      const sameQuiz = (out.match(/^\s*Q\d+\./gm) || []).length === (tail.match(/^\s*Q\d+\./gm) || []).length;
      const outBlocks = out.match(PROTECTED_WIDGET_RE) || [];
      const accepted = sameFaqs && sameQuiz && outBlocks.length === blocks.length;
      if (accepted) checkedBlocks = outBlocks;
      stageLog('widget-review', prompt, { accepted }, out);
    }
    const reviewed = restoreWidgets(d, checkedBlocks);
    emit({ type: 'data', name: 'reviewer', payload: reviewed });
    emit({ type: 'data', name: 'word-count', payload: { passes, final: countBodyWords(reviewed), budget: spec.maxWords } });
    return reviewed;
  });

  // 7) Link guard — drop any link the writer or reviewer produced that was not verified.
  const removedLinks = await stage('link-guard', async () => {
    const { markdown, removed } = stripUnverifiedLinks(draft, allowedUrls);
    draft = markdown;
    emit({ type: 'data', name: 'link-guard', payload: { removed } });
    return removed;
  });

  // 7b) Course links — the author's course links appear exactly once, subtly (see weaveCourseLinks), and
  // no sentence points the reader at any course or path page, including ones the pipeline found itself.
  const courseLinkReport = await stage('course-links', async () => {
    const { body, blocks } = protectWidgets(draft);
    const pointers = removeCoursePointers(body, courseLinks);
    const woven = courseLinks.length
      ? await weaveCourseLinks(pointers.markdown, courseLinks, title)
      : { markdown: pointers.markdown, links: [] as CourseLinkStatus[], removedSentences: [] as string[], applied: [] as any[] };
    if ('prompt' in woven && woven.prompt) stageLog('course-links', woven.prompt, { links: courseLinks }, { picks: (woven as any).picks, applied: woven.applied });
    // Course links never belong in the Quiz or FAQ.
    const cleanBlocks = blocks.map((b) => b.replace(MD_LINK_RE, (m, bang, text, href) => (courseLinks.some((u) => normalizeUrl(u) === normalizeUrl(stripTracking(href))) ? text : m)));
    draft = restoreWidgets(woven.markdown, cleanBlocks);
    const removedSentences = [...pointers.removed, ...woven.removedSentences];
    emit({ type: 'data', name: 'course-links', payload: { links: woven.links, removedSentences, applied: woven.applied } });
    return woven.links;
  });

  // 8) SEO meta ‖ image generation.
  const imgSubfolder = `edpresso/${slugify(title)}-${Date.now().toString(36)}`;
  const [meta, imageUrls] = await Promise.all([
    stage('seo-meta', async () => {
      const prompt = edpressoSeoMetaPrompt({ title, keywords: keywordsStr, primaryKeyword: classified.primaryKeyword || outline?.primaryKeyword, answer: draft });
      const raw = await openaiJSON(prompt, OPENAI_LIGHT);
      let parsed: any = {};
      try { parsed = parseJsonLoose(raw); } catch {}
      const result = {
        metaTitle: String(parsed.metaTitle || title),
        metaDescription: String(parsed.metaDescription || ''),
        slug: String(parsed.slug || slugify(title)),
      };
      stageLog('seo-meta', prompt, { title }, result);
      emit({ type: 'data', name: 'seo-meta', payload: result });
      return result;
    }),
    stage('images', async () => {
      // The writer or reviewer can still leave images out; plan the missing ones so every Shot has them.
      const missing = spec.images - [...draft.matchAll(IMAGE_TAG_RE)].length;
      if (missing > 0) {
        const { body, blocks } = protectWidgets(draft);
        // Offer only sections that do not already have an image.
        const headings = sectionHeadings(body).filter((s) => !s.hasImage).map((s) => s.heading);
        const prompt = edpressoImagePlanPrompt({
          title, missingCount: String(missing), headings: headings.map((h) => `"${h}"`).join(', '), answer: body,
        });
        let planned: any[] = [];
        try {
          const parsed: any = parseJsonLoose(await openaiJSON(prompt, OPENAI_LIGHT));
          planned = Array.isArray(parsed?.images) ? parsed.images.slice(0, missing) : [];
        } catch (e: any) {
          if (getAbortSignal()?.aborted) throw e;
        }
        let d = body;
        const added: any[] = [];
        for (const img of planned) {
          const description = String(img?.description || '').trim();
          if (!description) continue;
          const tag = `[image][Description]${description}[/Description][Caption]${String(img?.caption || '').trim()}[/Caption][/image]`;
          const next = insertImageInSection(d, String(img?.heading || ''), tag);
          if (next) { d = next; added.push(img); }
        }
        draft = restoreWidgets(d, blocks);
        stageLog('image-plan', prompt, { required: spec.images, missing }, { added });
        emit({ type: 'data', name: 'image-plan', payload: { required: spec.images, missing, added } });
      }
      const imageTags = [...draft.matchAll(IMAGE_TAG_RE)].map((m) => m[1]);
      const urls = await Promise.all(imageTags.map(async (inner, i) => {
        const { description, caption } = parseImageTag(inner);
        try {
          const r = await generateGptImage(`[Description]${description}[/Description][Caption]${caption}[/Caption]`, i + 1, imgSubfolder);
          stageLog(`image-generate#${i + 1}`, '(gpt-image-2)', { description }, { url: r.url });
          return r.url;
        } catch (e: any) {
          emit({ type: 'log', name: `image-generate#${i + 1}`, message: `Image generation failed, keeping placeholder: ${e?.message}` });
          return '';
        }
      }));
      emit({ type: 'data', name: 'images', payload: urls });
      return urls;
    }),
  ]);

  // 8b) Transitions — after images are placed, every pair of adjacent elements gets a sentence between them.
  draft = await stage('transitions', async () => {
    const t = await addTransitions(draft, title);
    if (t.prompt) stageLog('transitions', t.prompt, {}, { added: t.added });
    emit({ type: 'data', name: 'transitions', payload: { added: t.added } });
    return t.markdown;
  });

  // 9) Assemble — write image URLs into their tags so the Markdown is self-contained.
  const final = await stage('assemble', async () => {
    let i = 0;
    const markdown = draft.replace(/\[image\]([\s\S]*?)\[\/image\]/g, (m, inner) => {
      const url = imageUrls[i++];
      if (!url) return m;
      return `[image]${inner.replace(/\[Url\][\s\S]*?\[\/Url\]/i, '')}[Url]${url}[/Url][/image]`;
    });
    const faqs = faqQuestions(markdown);
    const present = new Set(faqs.map(normQuestion));
    const missingAuthorFaqs = userFaqs.filter((q) => !present.has(normQuestion(q)));
    const edpresso: Record<string, any> = {
      answerType: classified.answerType,
      answerTypeLabel: spec.label,
      detectedType: classified.detectedType,
      language: classified.language,
      wordBudget: spec.maxWords,
      wordBudgetLabel: spec.budget,
      wordCount: countBodyWords(markdown),
      counts: countSegments(markdown),
      primaryKeyword: classified.primaryKeyword || outline?.primaryKeyword,
      keywords,
      userFaqs,
      faqs,
      missingAuthorFaqs,
      competitorUrls,
      ...meta,
      verifiedLinks,
      rejectedLinks,
      removedLinks,
      courseLinks: courseLinkReport,
    };
    const result = {
      title,
      vertical: spec.label,
      markdown,
      html: edpressoToHtml(markdown),
      edpresso,
    };
    emit({ type: 'data', name: 'assemble', payload: { wordCount: edpresso.wordCount, counts: edpresso.counts, faqs: faqs.length } });
    return result;
  });

  // 10) Educative — create the Answer as a draft for review. A failure here keeps the local Shot;
  // it can be sent again from the Shot page.
  if (isEducativeConfigured()) {
    await stage('educative', async () => {
      try {
        const draftInfo = await pushAnswerDraft({ title, markdown: final.markdown, tags: keywords.slice(0, 5), slug: final.edpresso.slug });
        final.edpresso.educative = draftInfo;
        emit({ type: 'data', name: 'educative', payload: draftInfo });
      } catch (e: any) {
        if (getAbortSignal()?.aborted) throw e;
        final.edpresso.educativeError = String(e?.message || e);
        emit({ type: 'data', name: 'educative', payload: { error: final.edpresso.educativeError } });
      }
    });
  } else {
    emit({ type: 'log', name: 'educative', message: 'EDUCATIVE_FLASK_AUTH is not set; skipped creating the Answer on Educative.' });
  }

  emit({ type: 'final', payload: final });
  return final;
}
