// Edpresso Shots (Educative Answers) pipeline.
//
//   classify ─► competitor-research ‖ link-discovery ─► faq-check ─► link-verify ─► outline ─► quote-check
//     ─► writer ─► reviewer (body only; tightens until within the word budget; then Quiz/FAQ fact-check)
//     ─► code-check (runs every program on Educative; text must match the real output) ─► keyword-cap
//     ─► link-guard ─► course-links ─► seo-meta ‖ images ─► transitions ─► assemble ─► educative
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
  edpressoFaqCheckPrompt,
  edpressoCodeCheckPrompt,
  edpressoKeywordVariantsPrompt,
  edpressoCodeVerdictPrompt,
  edpressoCodeFixPrompt,
  edpressoTrimPrompt,
} from './edpressoPromptsRegistry';
import { sanitizeText } from './transforms';
import { generateGptImage, slugify } from './imageGen';
import { getAbortSignal } from './abortContext';
import { edpressoToHtml, countBodyWords, countSegments, parseImageTag, parseCodeTag } from './edpressoAssemble';
import { answerEditorUrl, isEducativeConfigured, parseAnswerId, pushAnswerDraft, runCode, type CodeRunResult } from './educative';

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
  existingAnswerUrl?: string; // optional editor link of an Answer whose content this Shot replaces
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
1. Direct answer: one or two sentences (at most 50 words) naming the cause and the fix. Then the hook: usually a one-sentence scenario in which the reader hits this error (the exact command or code and the message it prints). Then a key takeaways blockquote with 2–3 bullets.
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
1. Direct answer: one or two sentences (at most 50 words) that answer the title on their own, with the practical recommendation. Then the hook: a Callout widget with a real, relevant quote or a surprising fact, or a concrete scenario that opens the first paragraph.
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
1. Direct answer: one or two sentences (at most 50 words) that answer the title on their own, with the practical recommendation. Then the hook: a Callout widget with a real, relevant quote or a surprising fact, or a concrete scenario that opens the first paragraph.
2. Key takeaways blockquote with 4–6 specific bullets (one per method, plus when to use which).
3. Opening tied to the hook: why this task matters, in one or two sentences tied to the running example (real-world uses only if they connect to it), and a short bulleted preview of the methods covered.
4. A "What is…" section with a 40–60 word definition of the underlying concept (for example, what a random number or string concatenation is), with the creator and year of the tool or language in one clause when the research has it.
5. One section per method, headed "Method N: <method>" or "N. <Action> using <method>", ordered from the most common or simplest to the most specialized. Every method uses the same running example. For each: one or two sentences on what it is and when to use it (naming the line that does the work), numbered steps if setup is needed, a runnable [code] tag with a unique keyword-rich caption, a line-by-line explanation of the key lines, and 1–2 "Pros:" and "Cons:" bullets. Add a Note blockquote for gotchas (thread safety, type conversion, security).
6. A Pause and think widget after the method that raises the likeliest question.
7. A comparison table of all methods (use case, strengths, limitations or performance) with a title, followed by a short "how to choose" section. When methods give different results on some input, include one short program that runs them on that input and prints the difference.
8. Quiz widget (after a one-sentence lead-in), closing section, FAQ widget.`,
  },
  concept: {
    label: 'Concept or algorithm',
    maxWords: 1000,
    budget: 'up to 1,000 words (as short as the concept allows)',
    images: 2,
    structure: `Target: as short as the concept allows; at most 1,000 body words.
Order:
1. Direct answer: one or two sentences (at most 50 words) that answer the title on their own, with the practical recommendation. Then the hook: a Callout widget with a real, relevant quote or a surprising fact, or a concrete scenario that opens the first paragraph.
2. Key takeaways blockquote with 4–6 specific bullets.
3. "## What is <concept>?" — a 40–60 word definition, then history (who introduced it and when) if relevant, and what the name stands for if it is an abbreviation.
4. Motivation tied to the hook: why it matters, with real-world uses only where they connect to the running example or the problem it solves.
5. The problem it solves, with a concrete example using real values.
6. How it works: a step-by-step walkthrough (dry run) on the concrete example. Illustrate the walkthrough with images (a Slides widget placeholder may hold any further steps).
7. Formulas or complexity (Big O) in a LaTeX widget placeholder, with an explanation of where they come from.
8. Code: the bigger picture first, then a runnable [code] tag on the same example as the walkthrough, then a line-by-line explanation. A Pause and think widget after the walkthrough or the code, on the likeliest confusion.
9. When the title compares related concepts, give each its own "What is…" subsection and end with a comparison table.
10. Popular libraries or tools that implement it, when relevant.
11. Quiz widget (after a one-sentence lead-in), closing section, FAQ widget.`,
  },
  technology: {
    label: 'Technology or framework',
    maxWords: 1000,
    budget: 'up to 1,000 words',
    images: 2,
    structure: `Target: at most 1,000 body words.
Order:
1. Direct answer: one or two sentences (at most 50 words) that answer the title on their own, with the practical recommendation. Then the hook: a Callout widget with a quote from the creator or a well-known user, or a surprising fact, or a concrete scenario that opens the first paragraph.
2. Key takeaways blockquote with 4–6 specific bullets.
3. "## What is <technology>?" — a 40–60 word definition first (for the featured snippet), then a short history: creator, year, and how it evolved.
4. Why it matters: the problem it solves, adoption numbers, and well-known companies or products that use it (only facts from the research).
5. Key features in logical order (foundational features first, dependent features after; most important first), each with a one or two sentence explanation.
6. A "Hello World" or minimal example in a runnable [code] tag, with an explanation; for command-line tools, also an options table and a Terminal widget with commands to try.
7. Common use cases, then a Pause and think widget on the likeliest follow-up question.
8. Strengths and limitations (a table works well), plus ecosystem, deprecation, or version notes where relevant.
9. Quiz widget (after a one-sentence lead-in), closing section, FAQ widget.`,
  },
};

const NARROW_MAX_WORDS = 600;
const NARROW_NOTE = `Narrow topic: keep it short and focused on this one question. Key takeaways: 3–4 bullets. Explain the parent concept in one or two sentences only. No closing summary section. Skip the comparison table unless there are three or more methods, and never repeat the takeaways in it. FAQs: 5–8.`;

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
    // A line that starts with a Markdown link is prose; other "[" lines are tags.
    return l.trim() && !/^\s*(>|\||\[(?![^\]]*\]\()|\*\s)/.test(l) ? 'prose' : 'other';
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
export function linkableSentences(md: string): { line: number; start: number; text: string }[] {
  const lines = md.split('\n');
  const kinds = classifyLines(lines);
  const out: { line: number; start: number; text: string }[] = [];
  // The first paragraph is the direct answer (the featured snippet); it stays free of course links.
  const firstProse = kinds.findIndex((k, i) => k === 'prose' && !/^\s*>/.test(lines[i]));
  lines.forEach((line, i) => {
    if ((kinds[i] !== 'prose' && kinds[i] !== 'list') || i === firstProse) return;
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
// Anchors that say nothing about what the link teaches ("the first method", "this approach").
const GENERIC_ANCHOR_RE = /^(the|this|that|these|those|a|an|our|its)?\s*(first|second|third|last|next|previous|following|above|below|same|other|default)?\s*(method|methods|step|steps|approach|approaches|way|ways|one|option|options|section|example|examples|program|code|result|results|here|it)$/i;

function placeCourseLink(md: string, s: { line: number; start: number; text: string }, anchor: string, url: string): string | null {
  const a = anchor.trim();
  if (!a || a.split(/\s+/).length > 5 || isCourseNameAnchor(a, url) || GENERIC_ANCHOR_RE.test(a)) return null;
  // At least one content word of four or more letters (rejects anchors such as "R's" or "in R").
  if (!a.split(/\s+/).some((w) => /^[A-Za-z][\w+#.-]{3,}$/.test(w.replace(/['’]s$/, '')) && !/^(this|that|with|from|into|when|then|than|your|their|which|where|there|these|those|about)$/i.test(w))) return null;
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

  d = audit.markdown;
  const used = new Set<number>();
  let picks: any[] = [];
  let prompt = '';
  let todo = missing;
  // Two tries: the second one is told which anchors were rejected and why.
  for (let attempt = 1; attempt <= 2 && todo.length; attempt++) {
    prompt = edpressoCourseLinkPrompt({
      title,
      tasks: todo.map((l) => `- ${l.url} (teaches: ${courseTopic(l.url)})`).join('\n'),
      sentences: candidates.map((c, i) => `${i + 1}. ${c.text}`).join('\n'),
      feedback: attempt === 1 ? '' : `# Rejected earlier (pick different words)\n${(picks.map((p) => `- "${p?.anchor}" in sentence ${p?.sentence}: ${p?._why || 'not usable'}`).join('\n'))}`,
    });
    try {
      // The default model: choosing words that relate to the course is a judgement call.
      const parsed: any = parseJsonLoose(await openaiJSON(prompt));
      picks = Array.isArray(parsed?.links) ? parsed.links : [];
    } catch (e: any) {
      if (getAbortSignal()?.aborted) throw e;
      picks = [];
    }
    for (const l of todo) {
      // Options in the model's order; the first one whose sentence is free and whose anchor passes wins.
      for (const pick of picks.filter((p) => normalizeUrl(String(p?.url || '')) === normalizeUrl(l.url))) {
        const n = Number(pick?.sentence) - 1;
        const anchor = String(pick?.anchor || '');
        if (!candidates[n]) { pick._why = 'no such sentence'; continue; }
        if (used.has(candidates[n].line)) { pick._why = 'that sentence already has a course link'; continue; }
        const next = placeCourseLink(d, candidates[n], anchor, l.url);
        if (next) { d = next; used.add(candidates[n].line); applied.push({ url: l.url, sentence: candidates[n].text, anchor }); break; }
        pick._why = /[`*]/.test(anchor) ? 'contains inline code or bold'
          : !candidates[n].text.includes(anchor.trim()) ? 'not copied exactly from the sentence'
          : 'too generic, too long, or names the course';
      }
    }
    const linked = new Set(applied.map((a) => a.url));
    todo = todo.filter((l) => !linked.has(l.url));
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

// ---- Code: line-number comments, line references, and running every program. ----

const CODE_TAG_RE = /\[code\]([\s\S]*?)\[\/code\]/g;
const FENCE_IN_TAG_RE = /(```[^\n]*\n)([\s\S]*?)(```)/;

// Models "count" lines by writing a comment-only line ("# 1", "// 2") before each code line, or a
// trailing "  # 3" marker. Readers see those markers next to the editor's own line numbers, so strip
// them: comment-only number lines always, trailing markers when three or more lines carry them.
export function stripLineMarkers(md: string): string {
  return md.replace(CODE_TAG_RE, (tag, inner) => {
    const fixed = inner.replace(FENCE_IN_TAG_RE, (_m: string, open: string, code: string, close: string) => {
      let lines = code.split('\n').filter((l) => !/^\s*(#|\/\/|--|;|%)\s*\d+\s*$/.test(l));
      const trailing = /\s+(#|\/\/|--)\s*\d+\s*$/;
      if (lines.filter((l) => trailing.test(l)).length >= 3) lines = lines.map((l) => l.replace(trailing, ''));
      return `${open}${lines.join('\n')}${close}`;
    });
    return `[code]${fixed}[/code]`;
  });
}

export function stripCodeMarkers(code: string): string {
  const m = stripLineMarkers(`[code]\n\`\`\`\n${code}\n\`\`\`[/code]`).match(/```\n([\s\S]*?)\n?```/);
  return m ? m[1].replace(/\s+$/, '') : code;
}

function codeTags(md: string): { start: number; end: number; language: string; caption: string; code: string }[] {
  return [...md.matchAll(CODE_TAG_RE)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, ...parseCodeTag(m[1]) }));
}

// "**Line N:**" / "**Lines N–M:**" references in the text between a code tag and the next element or heading.
export function lineRefProblems(md: string): string[][] {
  const tags = codeTags(md);
  return tags.map((t, i) => {
    const lineCount = t.code.split('\n').length;
    const nextStart = tags[i + 1]?.start ?? md.length;
    let after = md.slice(t.end, nextStart);
    const stop = after.search(/^\s*(#{2,3}\s|\[(table|image)\]|\[\[[A-Za-z ]+ widget\]\]|EDPWIDGET\d+TOKEN)/m);
    if (stop > 0) after = after.slice(0, stop);
    const problems: string[] = [];
    for (const m of after.matchAll(/\*\*Lines?\s+(\d+)(?:\s*[–—-]\s*(\d+))?\s*:?\s*\*\*/g)) {
      const a = Number(m[1]), b = Number(m[2] || m[1]);
      if (a < 1 || b > lineCount || b < a) problems.push(`"${m[0]}" refers to a line the program does not have (it has ${lineCount} lines)`);
    }
    return problems;
  });
}

function numberedListing(code: string): string {
  const lines = code.split('\n');
  const w = String(lines.length).length;
  return lines.map((l, i) => `${String(i + 1).padStart(w, ' ')} | ${l}`).join('\n');
}

// ---- Terminal widget: only for command-line topics. ----

const TERMINAL_RE = /\[\[Terminal widget\]\][\s\S]*?\[\[\/Terminal widget\]\]/g;

// Removes Terminal widgets and the one- or two-sentence lead-in that asks the reader to try them.
export function removeTerminalWidgets(md: string): { markdown: string; removed: number } {
  let out = md;
  let removed = 0;
  for (let m = TERMINAL_RE.exec(out); m; m = TERMINAL_RE.exec(out)) {
    let start = m.index;
    const end = m.index + m[0].length;
    // The paragraph right before the widget, if it only invites the reader to try the commands.
    const before = out.slice(0, start).replace(/\s+$/, '');
    const paraStart = before.lastIndexOf('\n\n') + 1;
    const lead = before.slice(paraStart).trim();
    const isLead = lead && !/^\s*(#|\[|```|>|\||-|\*|\d+\.)/.test(lead)
      && /\b(try|terminal|practice|install|environment|commands?|run (these|the|them))\b/i.test(lead)
      && lead.split(/(?<=[.!?])\s+/).length <= 2;
    if (isLead) {
      start = paraStart;
      // A section that only held the terminal ("## Try it in your environment") goes with it.
      const rest = out.slice(0, start).replace(/\s+$/, '');
      const headingAt = rest.lastIndexOf('\n## ') + 1 || (rest.startsWith('## ') ? 0 : -1);
      const lastHeading = rest.slice(Math.max(headingAt, 0));
      if (headingAt >= 0 && /^#{2,3}\s[^\n]*$/.test(lastHeading.trim()) && /\b(try|terminal|environment|practice|hands-on)\b/i.test(lastHeading)) start = headingAt;
    }
    out = `${out.slice(0, start).replace(/\s+$/, '')}\n\n${out.slice(end).replace(/^\s+/, '')}`;
    TERMINAL_RE.lastIndex = 0;
    removed++;
  }
  return { markdown: out.replace(/\n{3,}/g, '\n\n').trim(), removed };
}

// ---- Quotes: used only when the exact words are on the cited page. ----

const normWords = (s: string) => s.toLowerCase()
  .replace(/[‘’“”"'`]/g, '')
  .replace(/&[a-z]+;|&#\d+;/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

async function fetchPageText(url: string): Promise<string> {
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,text/plain' }, signal: linkSignal() });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !/text\/(html|plain)|xml/i.test(type)) { res.body?.cancel().catch(() => {}); return ''; }
    const html = (await res.text()).slice(0, 3_000_000);
    return html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
  } catch (e: any) {
    if (getAbortSignal()?.aborted) throw e;
    return '';
  }
}

// True when every part of the quote (split at ellipses) of at least five words appears on the page.
export async function quoteFoundOnPage(quote: string, url: string): Promise<boolean> {
  if (!/^https?:\/\//i.test(url || '')) return false;
  const parts = quote.split(/\.\.\.|…|\[[^\]]*\]/).map(normWords).filter((p) => p.split(' ').length >= 5);
  if (!parts.length) return false;
  const page = normWords(await fetchPageText(url));
  return !!page && parts.every((p) => page.includes(p));
}

const QUOTED_RE = /["“]([^"”]{20,})["”]/;

// A Callout or blockquote whose quote is not one we confirmed is replaced by the fallback hook (Callout)
// or removed (a section blockquote).
function enforceVerifiedQuotes(md: string, verified: string[], fallback: string): { markdown: string; replaced: string[] } {
  const ok = (q: string) => verified.some((v) => { const a = normWords(v), b = normWords(q); return !!a && !!b && (a.includes(b) || b.includes(a)); });
  const replaced: string[] = [];
  let out = md.replace(/\[\[Callout widget\]\]([\s\S]*?)\[\[\/Callout widget\]\]/g, (m, body) => {
    const q = String(body).match(QUOTED_RE)?.[1];
    if (!q || ok(q)) return m;
    replaced.push(q);
    return fallback ? `[[Callout widget]]\n${fallback}\n[[/Callout widget]]` : '';
  });
  const lines = out.split('\n');
  const kinds = classifyLines(lines);
  out = lines.filter((l, i) => {
    if (kinds[i] === 'block' || !/^\s*>\s*["“]/.test(l)) return true;
    const q = l.match(QUOTED_RE)?.[1];
    if (!q || !/[—–-]\s*\S/.test(l.slice(l.lastIndexOf(q.slice(-5))))) return true;
    if (ok(q)) return true;
    replaced.push(q);
    return false;
  }).join('\n');
  return { markdown: out.replace(/\n{3,}/g, '\n\n').trim(), replaced };
}

// ---- Research brief sections ----

function researchList(research: string, heading: string): string[] {
  const m = String(research).match(new RegExp(`^#{1,3}\\s*${heading}[^\\n]*\\n([\\s\\S]*?)(?=^#{1,3}\\s|$(?![\\s\\S]))`, 'im'));
  return (m?.[1] || '').split('\n').map((l) => l.replace(/^\s*[-*\d.)]+\s*/, '').trim()).filter((l) => l && !/^\(none/i.test(l));
}

// ---- Keyword cap: the exact primary keyword at most once in the first paragraph and once in a "##" heading. ----

interface KeywordUse { line: number; kind: 'heading' | 'prose' | 'caption' | 'table-title' | 'image-caption'; text: string }

function exactPhraseRe(phrase: string): RegExp {
  const esc = phrase.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![\\w-])${esc}(?![\\w-])`, 'gi');
}

// Every place the exact phrase is used (outside code and the protected Quiz/FAQ), with the uses that
// may stay: the first one in the first prose paragraph and the first one in a "##" heading.
export function keywordUses(md: string, phrase: string): { uses: KeywordUse[]; extra: KeywordUse[] } {
  const re = exactPhraseRe(phrase);
  const lines = md.split('\n');
  const kinds = classifyLines(lines);
  const uses: KeywordUse[] = [];
  let inFence = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) { inFence = !inFence; return; }
    if (inFence) return;
    const count = (l.match(re) || []).length;
    if (!count) return;
    if (kinds[i] === 'heading') uses.push({ line: i, kind: 'heading', text: l });
    else if (/^\s*Caption:/i.test(l)) uses.push({ line: i, kind: 'caption', text: l.replace(/^\s*Caption:\s*/i, '') });
    else if (/^\s*Table title:/i.test(l)) uses.push({ line: i, kind: 'table-title', text: l.replace(/^\s*Table title:\s*/i, '') });
    else if (/\[Caption\]/i.test(l)) uses.push({ line: i, kind: 'image-caption', text: l.match(/\[Caption\]([\s\S]*?)\[\/Caption\]/i)?.[1] || '' });
    else if (kinds[i] !== 'block') {
      // A line may hold the phrase more than once; each sentence is its own use.
      for (const m of l.matchAll(re)) {
        const sentence = sentenceAround(l, m.index!);
        if (!uses.some((u) => u.line === i && u.text === sentence)) uses.push({ line: i, kind: 'prose', text: sentence });
      }
    }
  });
  const firstProseLine = lines.findIndex((l, i) => kinds[i] === 'prose' && !/^\s*>/.test(l));
  const keepProse = uses.find((u) => u.kind === 'prose' && u.line === firstProseLine);
  const keepHeading = uses.find((u) => u.kind === 'heading' && /^##\s/.test(lines[u.line]));
  return { uses, extra: uses.filter((u) => u !== keepProse && u !== keepHeading) };
}

export async function capKeyword(md: string, phrase: string, variants: string[], title: string): Promise<{
  markdown: string; before: number; after: number; rewrites: { from: string; to: string }[]; prompt?: string;
}> {
  const { uses, extra } = keywordUses(md, phrase);
  if (!phrase.trim() || !extra.length) return { markdown: md, before: uses.length, after: uses.length, rewrites: [] };
  const prompt = edpressoKeywordVariantsPrompt({
    title,
    phrase,
    variants: variants.length ? variants.map((v) => `- ${v}`).join('\n') : '(none found; use plain descriptive words)',
    items: extra.map((u, i) => `${i + 1}. (${u.kind}) ${u.text}`).join('\n'),
  });
  let picks: any[] = [];
  try {
    const parsed: any = parseJsonLoose(await openaiJSON(prompt));
    picks = Array.isArray(parsed?.rewrites) ? parsed.rewrites : [];
  } catch (e: any) {
    if (getAbortSignal()?.aborted) throw e;
  }
  const lines = md.split('\n');
  const rewrites: { from: string; to: string }[] = [];
  const links = (s: string) => [...s.matchAll(MD_LINK_RE)].map((m) => m[0]).sort().join('|');
  extra.forEach((u, i) => {
    let to = String(picks.find((p) => Number(p?.n) === i + 1)?.text || '').trim();
    if (u.kind === 'heading') to = to.replace(/^#+\s*/, '');
    const from = u.kind === 'heading' ? u.text.replace(/^#+\s*/, '') : u.text;
    // Accept only a rewrite that drops the phrase and keeps links, popups, and inline code.
    if (!to || exactPhraseRe(phrase).test(to) || links(to) !== links(from)
      || (to.match(/#key#/g) || []).length !== (from.match(/#key#/g) || []).length
      || (to.match(/`/g) || []).length % 2 === 1 || to.length > from.length * 2 + 40) return;
    const line = lines[u.line];
    if (!line.includes(from)) return;
    lines[u.line] = line.replace(from, () => to);
    rewrites.push({ from, to });
  });
  const markdown = lines.join('\n');
  return { markdown, before: uses.length, after: keywordUses(markdown, phrase).uses.length, rewrites, prompt };
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
    const result = {
      answerType, detectedType: detected, language,
      primaryKeyword: String(parsed.primaryKeyword || keywords[0] || title).trim(),
      commandLine: parsed.commandLine === true,
      scope: parsed.scope === 'narrow' ? 'narrow' as const : 'broad' as const,
      reason: parsed.reason || '',
    };
    stageLog('classify', prompt, { title, keywords: keywordsStr }, result);
    emit({ type: 'data', name: 'classify', payload: result });
    return result;
  });
  // A narrow topic (one parameter, option, or behavior) gets a shorter Answer with no closing summary.
  const narrow = classified.scope === 'narrow' && classified.answerType !== 'error';
  const baseSpec = ANSWER_TYPES[classified.answerType];
  const spec: AnswerTypeSpec = narrow
    ? {
        ...baseSpec,
        maxWords: Math.min(baseSpec.maxWords, NARROW_MAX_WORDS),
        budget: baseSpec.maxWords > NARROW_MAX_WORDS ? `300–${NARROW_MAX_WORDS} words (a narrow topic; never more than ${NARROW_MAX_WORDS})` : baseSpec.budget,
        structure: `${baseSpec.structure}\n${NARROW_NOTE}`,
      }
    : baseSpec;
  const terminalRule = classified.commandLine
    ? 'Allowed: this topic is done on the command line. Use one Terminal widget for the commands readers should try, and only when every command works in the environment its Setup part creates.'
    : 'Not allowed: this topic is not a command-line task. Do not include a Terminal widget (no install, setup, or "try it in your environment" terminal); runnable programs go in [code] tags.';
  const closingRule = narrow
    ? 'No closing section: this is a narrow topic. After the Quiz (or the last section when there is no Quiz), one sentence introduces the FAQ, so the Quiz and FAQ are never back to back.'
    : 'A short closing section (1–3 sentences) with a meaningful heading that adds a decision rule or the next step, without restating the key takeaways. No call to action and no pointer to a course or path. It sits between the Quiz and the FAQ, so they are never back to back.';
  const primaryKeyword = classified.primaryKeyword || title;
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

  // 2b) FAQ check — author FAQs that drift from this Answer's exact question are dropped (and reported),
  // spelling and names are fixed, and People-also-ask questions are ranked by relevance.
  const paaQuestions = researchList(research, 'People also ask').filter((q) => /\?\s*$/.test(q) || q.split(/\s+/).length >= 4);
  const faqCheck = await stage('faq-check', async () => {
    const result = {
      kept: userFaqs,
      dropped: [] as { question: string; reason: string }[],
      corrected: [] as { from: string; to: string }[],
      candidates: paaQuestions,
    };
    if (!userFaqs.length && !paaQuestions.length) return result;
    const prompt = edpressoFaqCheckPrompt({
      title, primaryKeyword,
      authorFaqs: userFaqs.length ? userFaqs.map((q, i) => `${i + 1}. ${q}`).join('\n') : '(none)',
      candidates: paaQuestions.length ? paaQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n') : '(none)',
    });
    let parsed: any = null;
    try { parsed = parseJsonLoose(await openaiJSON(prompt)); } catch (e: any) { if (getAbortSignal()?.aborted) throw e; }
    if (parsed) {
      // A correction may fix spelling and names, never reword: most words must stay the same.
      const safeFix = (from: string, to: string) => {
        const a = new Set(normWords(from).split(' ')), b = normWords(to).split(' ');
        const same = b.filter((w) => a.has(w)).length;
        return to && same / Math.max(a.size, b.length) >= 0.6 ? to.trim() : from;
      };
      const author: any[] = Array.isArray(parsed.author) ? parsed.author : [];
      result.kept = [];
      userFaqs.forEach((q, i) => {
        const r = author.find((x) => Number(x?.n) === i + 1);
        const fixed = r ? safeFix(q, String(r.question || '')) : q;
        if (r && r.onTopic === false) { result.dropped.push({ question: q, reason: String(r.reason || 'off topic') }); return; }
        if (fixed !== q) result.corrected.push({ from: q, to: fixed });
        result.kept.push(fixed);
      });
      const cands: any[] = Array.isArray(parsed.candidates) ? parsed.candidates : [];
      result.candidates = cands
        .filter((c) => Number(c?.relevance) >= 4 && paaQuestions[Number(c?.n) - 1])
        .sort((a, b) => Number(b.relevance) - Number(a.relevance))
        .map((c) => safeFix(paaQuestions[Number(c.n) - 1], String(c.question || '')))
        .slice(0, 10);
    }
    stageLog('faq-check', prompt, { userFaqs, paaQuestions }, result);
    emit({ type: 'data', name: 'faq-check', payload: result });
    return result;
  });
  const authorFaqs = faqCheck.kept;

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
  const allowedUrls = new Set<string>([
    ...verifiedLinks.flatMap((l) => [normalizeUrl(l.url), normalizeUrl(l.finalUrl)]),
    ...courseLinks.map(normalizeUrl),
  ]);

  // 4) Outline.
  const outline = await stage('outline', async () => {
    const args = {
      title, answerTypeLabel: spec.label, wordBudget: spec.budget, typeStructure: spec.structure,
      language: languageStr, keywords: keywordsStr,
      userFaqs: authorFaqs.length ? authorFaqs.map((q) => `- ${q}`).join('\n') : '(none provided — take all FAQs from the candidates)',
      research, verifiedLinks: verifiedLinksStr, imageCount: imageCountStr,
      primaryKeyword,
      faqCandidates: faqCheck.candidates.length ? faqCheck.candidates.map((q, i) => `${i + 1}. ${q}`).join('\n') : '(none)',
      faqTarget: narrow ? 'Aim for 5–8 FAQs in total.' : 'Aim for 8–12 FAQs in total (fewer if the topic genuinely has fewer distinct questions).',
    };
    const prompt = edpressoOutlinePrompt(args);
    const raw = await openaiJSON(prompt);
    let parsed: any;
    try { parsed = parseJsonLoose(raw); } catch { parsed = { raw }; }
    stageLog('outline', prompt, { title, answerType: classified.answerType }, parsed);
    emit({ type: 'data', name: 'outline', payload: parsed });
    return parsed;
  });

  // 4b) Quote check — a quote is used only when its exact words are on the page it cites.
  const quoteCheck = await stage('quote-check', async () => {
    const checks: { quote: string; sourceUrl: string; found: boolean; use: 'hook' | 'section' }[] = [];
    const verifiedQuotes: string[] = [];
    if (outline?.hook?.type === 'quote' && outline.hook.text) {
      const found = await quoteFoundOnPage(String(outline.hook.text), String(outline.hook.sourceUrl || ''));
      checks.push({ quote: outline.hook.text, sourceUrl: outline.hook.sourceUrl || '', found, use: 'hook' });
      if (found) verifiedQuotes.push(outline.hook.text);
      else outline.hook = outline.fallbackHook?.text ? { ...outline.fallbackHook, attribution: '' } : { type: 'scenario', text: '', bridge: '' };
    }
    if (outline?.sectionQuote?.text) {
      const found = await quoteFoundOnPage(String(outline.sectionQuote.text), String(outline.sectionQuote.sourceUrl || ''));
      checks.push({ quote: outline.sectionQuote.text, sourceUrl: outline.sectionQuote.sourceUrl || '', found, use: 'section' });
      if (found) verifiedQuotes.push(outline.sectionQuote.text);
      else outline.sectionQuote = null;
    }
    // Callout text to use if the writer puts in a quote that was not confirmed anyway.
    const fallback = outline?.hook?.type !== 'quote' && outline?.hook?.text
      ? String(outline.hook.text)
      : String(outline?.fallbackHook?.text || '');
    const result = { checks, verifiedQuotes, fallback };
    emit({ type: 'data', name: 'quote-check', payload: result });
    return result;
  });

  // Applied after the writer and the reviewer: no line-number comments in code, no unconfirmed quotes,
  // and no Terminal widget on a topic that is not done on the command line.
  const cleanDraft = (md: string) => {
    let out = stripLineMarkers(md);
    const q = enforceVerifiedQuotes(out, quoteCheck.verifiedQuotes, quoteCheck.fallback);
    out = q.markdown;
    const t = classified.commandLine ? { markdown: out, removed: 0 } : removeTerminalWidgets(out);
    return { markdown: t.markdown, replacedQuotes: q.replaced, removedTerminals: t.removed };
  };

  // 5) Writer (streamed).
  let draft = await stage('writer', async () => {
    const prompt = edpressoWriterPrompt({
      title, answerTypeLabel: spec.label, wordBudget: spec.budget, typeStructure: spec.structure,
      language: languageStr, keywords: keywordsStr, outline: JSON.stringify(outline, null, 2),
      research, verifiedLinks: verifiedLinksStr, imageCount: imageCountStr,
      primaryKeyword, terminalRule, closingRule,
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
    const cleaned = cleanDraft(normalizeImageTags(sanitizeText(out)).trim());
    if (cleaned.replacedQuotes.length || cleaned.removedTerminals) {
      emit({ type: 'log', name: 'writer', message: `Cleanup: ${cleaned.replacedQuotes.length} unconfirmed quote(s) replaced, ${cleaned.removedTerminals} Terminal widget(s) removed` });
    }
    emit({ type: 'data', name: 'writer', payload: cleaned.markdown });
    return cleaned.markdown;
  });

  // 6) Reviewer — checklist pass, then tightening passes until the body fits the word budget.
  draft = await stage('reviewer', async () => {
    const { body, blocks } = protectWidgets(draft);
    let d = body;
    const passes: { pass: number; wordsBefore: number; wordsAfter: number; accepted: boolean }[] = [];
    for (let pass = 1; pass <= 3; pass++) {
      const wordsBefore = countBodyWords(d);
      if (pass > 1 && wordsBefore <= spec.maxWords) break;
      const prompt = edpressoReviewerPrompt({
        title, answerTypeLabel: spec.label, wordBudget: spec.budget, currentWordCount: String(wordsBefore),
        typeStructure: spec.structure, keywords: keywordsStr, verifiedLinks: verifiedLinksStr,
        primaryKeyword, terminalRule, closingRule, draft: d,
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
    const reviewed = cleanDraft(restoreWidgets(d, checkedBlocks)).markdown;
    emit({ type: 'data', name: 'reviewer', payload: reviewed });
    emit({ type: 'data', name: 'word-count', payload: { passes, final: countBodyWords(reviewed), budget: spec.maxWords } });
    return reviewed;
  });

  // 6b) Code check — run every program on Educative. (A) Each program whose real output doesn't show
  // what it is there to show is rewritten, re-run, and judged again (up to 3 attempts). (B) With the code
  // final, the text is made to agree with the real output, line references, and names.
  const codeCheck = await stage('code-check', async () => {
    if (!codeTags(draft).length) return { skipped: 'no code', programs: [] as any[], final: [] as any[], lineRefProblems: [] as string[][] };
    const run = async (language: string, code: string): Promise<CodeRunResult> => {
      if (!isEducativeConfigured()) return { ran: false, ok: false, stdout: '', stderr: '', time: '', reason: 'EDUCATIVE_FLASK_AUTH is not set' };
      try { return await runCode(language, code); } catch (e: any) {
        if (getAbortSignal()?.aborted) throw e;
        return { ran: false, ok: false, stdout: '', stderr: '', time: '', reason: `run request failed: ${String(e?.message || e).slice(0, 200)}` };
      }
    };
    const outputText = (r: CodeRunResult) => r.ran
      ? `Exit status: ${r.ok ? '0 (succeeded)' : `failed (${r.reason || 'error'})`}${r.time ? `, ${r.time}` : ''}\nOutput:\n\`\`\`\n${r.stdout.trim() || '(no output)'}\n\`\`\`${r.stderr.trim() ? `\nErrors:\n\`\`\`\n${r.stderr.trim()}\n\`\`\`` : ''}`
      : `Not run (${r.reason}).`;

    // (A) Per program: verdict, fix, re-run.
    let { body, blocks } = protectWidgets(draft);
    const tags = codeTags(body);
    const programs = await mapLimit(tags.map((t, i) => ({ t, i })), 2, async ({ t, i }) => {
      // The program's context: from its section heading to the next program or heading after it.
      const sectionStart = Math.max(0, body.lastIndexOf('\n#', t.start));
      const nextStart = tags[i + 1]?.start ?? body.length;
      let tail = body.slice(t.end, nextStart);
      const stop = tail.search(/^#{2,3}\s/m);
      if (stop > 0) tail = tail.slice(0, stop);
      const context = `${body.slice(sectionStart, t.start)}[the program]\n${tail}`.trim().slice(-4000);
      let code = t.code;
      let result = await run(t.language, code);
      const attempts: any[] = [];
      if (!result.ran) return { index: i, code, result, attempts, changed: false };
      for (let attempt = 1; attempt <= 3; attempt++) {
        const prompt = edpressoCodeVerdictPrompt({
          title, language: t.language, context, program: numberedListing(code), output: outputText(result),
          attempt: attempt === 1 ? '' : `This is attempt ${attempt}: an earlier fix still did not show the effect.`,
        });
        let verdict: any = {};
        try { verdict = parseJsonLoose(await openaiJSON(prompt)); } catch (e: any) { if (getAbortSignal()?.aborted) throw e; }
        const shows = verdict?.shows === true && result.ok;
        attempts.push({ attempt, shows, purpose: verdict?.purpose, problem: verdict?.problem, stdout: result.stdout.slice(0, 500) });
        stageLog(`code-verdict#${i + 1}.${attempt}`, prompt, { program: i + 1 }, verdict);
        if (shows || attempt === 3) break;
        const fixPrompt = edpressoCodeFixPrompt({
          title, language: t.language,
          purpose: String(verdict?.purpose || 'Show the effect the text describes.'),
          problem: String(verdict?.problem || (result.ok ? 'The output does not show the effect.' : 'The program fails.')),
          program: code, output: outputText(result),
          attempt: attempt === 1 ? '' : `An earlier rewrite still did not show it; take a clearly different approach (different data or a loop over seeds).`,
        });
        const fixed = String(await generateText(fixPrompt, { maxTokens: 4000 })).replace(/^\s*```[^\n]*\n|\n?```\s*$/g, '').replace(/\s+$/, '');
        stageLog(`code-fix#${i + 1}.${attempt}`, fixPrompt, { program: i + 1 }, fixed);
        if (!fixed || fixed === code) break;
        const candidate = stripCodeMarkers(fixed);
        const next = await run(t.language, candidate);
        // Keep a fix only if it runs; a failing fix never replaces a working program.
        if (next.ok || !result.ok) { code = candidate; result = next; }
        else break;
      }
      return { index: i, code, result, attempts, changed: code.trim() !== t.code.trim() };
    });
    // Put changed programs back into their tags (from the end so offsets stay valid).
    for (const p of [...programs].reverse()) {
      if (!p.changed) continue;
      const t = tags[p.index];
      const tag = body.slice(t.start, t.end).replace(FENCE_IN_TAG_RE, (_m, open, _code, close) => `${open}${p.code}\n${close}`);
      body = `${body.slice(0, t.start)}${tag}${body.slice(t.end)}`;
    }

    // (B) Text: agree with the real output; fix line references and names. The code is final here.
    const refs = lineRefProblems(body);
    const report = codeTags(body).map((t, i) => {
      const p = programs[i];
      return `## Program ${i + 1} (${t.language})${t.caption ? `: ${t.caption}` : ''}${p.changed ? ' — rewritten so its output shows the effect; update the text that describes it' : ''}\n\`\`\`\n${numberedListing(t.code)}\n\`\`\`\n${outputText(p.result)}\nLine-reference problems: ${refs[i].join('; ') || 'none found'}`;
    }).join('\n\n');
    const needsText = programs.some((p) => p.changed || (p.result.ran && !p.result.ok)) || refs.some((r) => r.length) || programs.some((p) => p.result.ran);
    let textAccepted = false;
    if (needsText) {
      const prompt = edpressoCodeCheckPrompt({
        title, language: languageStr, wordBudget: spec.budget, currentWordCount: String(countBodyWords(body)), report, draft: body,
      });
      const out = stripLineMarkers(normalizeImageTags(sanitizeText(await generateText(prompt, { maxTokens: 16000 }))).trim());
      const sameCode = codeTags(out).map((t) => t.code.trim()).join('\n#--#\n') === codeTags(body).map((t) => t.code.trim()).join('\n#--#\n');
      const tokensKept = blocks.every((_b, i) => out.includes(`EDPWIDGET${i}TOKEN`));
      textAccepted = isSafeRewrite(body, out) && sameCode && tokensKept;
      if (textAccepted) body = out;
      stageLog('code-check-text', prompt, { programs: tags.length, sameCode }, out);
    }
    draft = restoreWidgets(body, blocks);
    const final = codeTags(draft).map((t, i) => ({
      program: i + 1, language: t.language, caption: t.caption, changed: programs[i]?.changed || false,
      ran: programs[i]?.result.ran, ok: programs[i]?.result.ok, reason: programs[i]?.result.reason,
      shows: programs[i]?.attempts.some((a: any) => a.shows) ?? null,
      stdout: (programs[i]?.result.stdout || '').slice(0, 1500), stderr: (programs[i]?.result.stderr || '').slice(0, 600),
    }));
    const payload = { programs: programs.map((p) => ({ program: p.index + 1, changed: p.changed, attempts: p.attempts })), textAccepted, final, lineRefProblems: lineRefProblems(draft) };
    emit({ type: 'data', name: 'code-check', payload });
    return payload;
  });

  // 6c) Keyword cap — the exact primary keyword stays only in the first paragraph and one "##" heading
  // (plus the title); every other use is rewritten into a phrasing people also search.
  const keywordCap = await stage('keyword-cap', async () => {
    const variants = [...new Set([...researchList(research, 'Related keywords'), ...keywords])]
      .filter((v) => v.length < 80 && !exactPhraseRe(primaryKeyword).test(v) && normWords(v) !== normWords(primaryKeyword))
      .slice(0, 15);
    const { body, blocks } = protectWidgets(draft);
    let d = body;
    const passes: any[] = [];
    for (let pass = 1; pass <= 2; pass++) {
      const r = await capKeyword(d, primaryKeyword, variants, title);
      passes.push({ pass, before: r.before, after: r.after, rewrites: r.rewrites });
      if (r.prompt) stageLog(`keyword-cap#${pass}`, r.prompt, { phrase: primaryKeyword }, r.rewrites);
      d = r.markdown;
      if (!keywordUses(d, primaryKeyword).extra.length || !r.rewrites.length) break;
    }
    draft = restoreWidgets(d, blocks);
    const result = { phrase: primaryKeyword, uses: keywordUses(d, primaryKeyword).uses.length, passes };
    emit({ type: 'data', name: 'keyword-cap', payload: result });
    return result;
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
      const prompt = edpressoSeoMetaPrompt({ title, keywords: keywordsStr, primaryKeyword, answer: draft });
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
      // Alt text: Educative uses the caption as the image's alt, so write the final caption into each tag.
      draft = draft.replace(IMAGE_TAG_RE, (m, inner) => {
        const { caption } = parseImageTag(inner);
        if (!caption) return m;
        return /\[Caption\][\s\S]*?\[\/Caption\]/i.test(inner)
          ? m.replace(/\[Caption\][\s\S]*?\[\/Caption\]/i, () => `[Caption]${caption}[/Caption]`)
          : m.replace(/\[\/image\]$/i, () => `[Caption]${caption}[/Caption][/image]`);
      });
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

  // 8c) Word trim — later stages can push the body over budget; cut prose once more without touching
  // code, images, widgets, or course links.
  await stage('word-trim', async () => {
    const before = countBodyWords(draft);
    if (before <= spec.maxWords) return { before, after: before, accepted: false, skipped: 'within budget' };
    const passes: any[] = [];
    for (let pass = 1; pass <= 2 && countBodyWords(draft) > spec.maxWords; pass++) {
    const { body, blocks } = protectWidgets(draft);
    const prompt = edpressoTrimPrompt({
      title, wordBudget: spec.budget, currentWordCount: String(countBodyWords(body)),
      cut: String(countBodyWords(body) - spec.maxWords + 15), primaryKeyword, draft: body,
    });
    const out = cleanDraft(normalizeImageTags(sanitizeText(await generateText(prompt, { maxTokens: 16000 }))).trim()).markdown;
    const sameCode = codeTags(out).map((t) => t.code.trim()).join('\n#--#\n') === codeTags(body).map((t) => t.code.trim()).join('\n#--#\n');
    const tokensKept = blocks.every((_b, i) => out.includes(`EDPWIDGET${i}TOKEN`));
    const count = (md: string, re: RegExp) => (md.match(re) || []).length;
    const widgetsKept = count(out, /\[\[[A-Za-z ]+ widget\]\]/g) === count(body, /\[\[[A-Za-z ]+ widget\]\]/g) && count(out, /\[image\]/g) === count(body, /\[image\]/g) && count(out, /\[table\]/g) === count(body, /\[table\]/g);
    const courseKept = courseLinks.every((u) => !body.includes(u) || out.includes(u));
    const after = countBodyWords(out);
    const accepted = isSafeRewrite(body, out) && sameCode && tokensKept && widgetsKept && courseKept && after < countBodyWords(body)
      && keywordUses(out, primaryKeyword).extra.length <= keywordUses(body, primaryKeyword).extra.length;
    if (accepted) draft = restoreWidgets(out, blocks);
    stageLog(`word-trim#${pass}`, prompt, { before: countBodyWords(body), budget: spec.maxWords }, { after, accepted, sameCode, tokensKept, widgetsKept, courseKept });
    passes.push({ pass, after, accepted });
    if (!accepted) break;
    }
    const result = { before, after: countBodyWords(draft), passes };
    emit({ type: 'data', name: 'word-trim', payload: result });
    return result;
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
    const missingAuthorFaqs = authorFaqs.filter((q) => !present.has(normQuestion(q)));
    const edpresso: Record<string, any> = {
      answerType: classified.answerType,
      answerTypeLabel: spec.label,
      detectedType: classified.detectedType,
      language: classified.language,
      wordBudget: spec.maxWords,
      wordBudgetLabel: spec.budget,
      wordCount: countBodyWords(markdown),
      counts: countSegments(markdown),
      primaryKeyword,
      keywords,
      userFaqs,
      faqs,
      missingAuthorFaqs,
      authorFaqs,
      droppedAuthorFaqs: faqCheck.dropped,
      correctedFaqs: faqCheck.corrected,
      scope: classified.scope,
      commandLine: classified.commandLine,
      quoteCheck: quoteCheck.checks,
      codeCheck,
      keywordCap,
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

  // 10) Educative — create the Answer as a draft for review, or replace the content of the existing
  // Answer the author linked. A failure here keeps the local Shot; it can be sent again from the Shot page.
  const replaceId = parseAnswerId(input.existingAnswerUrl);
  if (replaceId) final.edpresso.replacesAnswer = { shotId: replaceId, editorUrl: answerEditorUrl(replaceId) };
  if (isEducativeConfigured()) {
    await stage('educative', async () => {
      try {
        if (input.existingAnswerUrl?.trim() && !replaceId) throw new Error(`Not an Answer editor link: ${input.existingAnswerUrl}`);
        const draftInfo = await pushAnswerDraft({
          title,
          markdown: final.markdown,
          tags: keywords.slice(0, 5),
          slug: final.edpresso.slug,
          ...(replaceId ? { shotId: replaceId, replaceExisting: true } : {}),
        });
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
