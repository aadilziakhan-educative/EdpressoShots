// Edpresso Shots (Educative Answers) pipeline.
//
//   classify ─► competitor-research ‖ link-discovery ─► faq-check ─► link-verify ─► outline ─► quote-check
//     ─► writer ─► reviewer (body only; tightens until within the word budget; then Quiz/FAQ fact-check)
//     ─► code-check (runs every program on Educative; text must match the real output) ─► keyword-cap
//     ─► link-guard ─► course-links ─► seo-meta ‖ images ─► transitions ─► assemble ─► educative
//
// The writer produces code and tables itself (inside [code]/[table] tags)
// so line-by-line explanations always match the code. Only images are generated separately.
// Widgets (quiz, FAQ, callout, slides, LaTeX, terminal, pause and think) are emitted as
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
  edpressoCoverageCheckPrompt,
  edpressoCoverageFixPrompt,
  edpressoImageSyncPrompt,
  edpressoRelatedCalloutPrompt,
  edpressoCourseLinkRewritePrompt,
  edpressoDocCheckPrompt,
  edpressoFaqSearchTermsPrompt,
  edpressoFaqLinkPrompt,
  edpressoFaqAnswerPrompt,
  edpressoAssessPrompt,
} from './edpressoPromptsRegistry';
import { sanitizeText } from './transforms';
import { generateGptImage, slugify } from './imageGen';
import katex from 'katex';
import { getAbortSignal } from './abortContext';
import { edpressoToHtml, countBodyWords, countSegments, parseImageTag, parseCodeTag, parseSlides, normalizeKeywordSyntax } from './edpressoAssemble';
import { answerEditorUrl, getAnswer, readAnswerForReview, isEducativeConfigured, parseAnswerId, pushAnswerDraft, runCode, searchAnswers, type CodeRunResult } from './educative';

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
  relatedAnswers?: string;    // optional series or prerequisite Answer links, one per line (max 2)
  relatedSentence?: string;   // optional sentence for the Callout that links them
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
6. How it works: a step-by-step walkthrough (dry run) on the concrete example. Illustrate the walkthrough with a Slides widget: one slide per step on the concrete example.
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

const NARROW_MAX_WORDS = 800;
const NARROW_NOTE = `Narrow topic: keep it short and focused on this one question; this order replaces the one above where they differ.
1. Direct answer, hook, key takeaways (3–4 bullets).
2. A "##" section that answers the core question the way people search it (for example "What does nstart do in kmeans()?"): a 40–60 word definition, with the parent concept in one or two sentences at most.
3. Right after it, the first runnable program: the basic usage on the running example, so code appears in the first third of the Answer.
4. One section on how it works, with one walkthrough (a Slides widget or a numbered list, not both). Don't split "why it matters", "the problem it solves", and "how it changes the result" into separate sections.
5. The most searched warning or error and the documented edge cases (for example, an argument that is ignored in some case), each with a short runnable program where it can be shown.
6. A Pause and think widget, the Quiz, a one- or two-sentence closing with a decision rule (never a summary), then the FAQ. No "popular implementations" or "background" section.
Skip the comparison table unless there are three or more methods, and never repeat the takeaways in it. FAQs: 5–8.`;

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
export const MAX_RELATED_ANSWERS = 2;
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
const SLIDES_WIDGET_RE = /\[\[Slides widget\]\]([\s\S]*?)\[\[\/Slides widget\]\]/g;

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
// What a course teaches, from its page: the <title> and meta description (falls back to the URL slug).
const courseInfoCache = new Map<string, string>();
export async function courseInfo(url: string): Promise<string> {
  if (courseInfoCache.has(url)) return courseInfoCache.get(url)!;
  let info = '';
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' }, signal: linkSignal() });
    const html = res.ok ? (await res.text()).slice(0, 400_000) : '';
    const pick = (re: RegExp) => (html.match(re)?.[1] || '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
    const title = pick(/<title[^>]*>([^<]+)<\/title>/i);
    const desc = pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) || pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
    info = [title, desc].filter(Boolean).join(' — ');
  } catch (e: any) {
    if (getAbortSignal()?.aborted) throw e;
  }
  info = info || courseTopic(url);
  courseInfoCache.set(url, info);
  return info;
}

const ANCHOR_STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'your', 'you', 'are', 'how', 'what', 'when', 'use', 'using', 'learn', 'course', 'path', 'educative',
  // Words every course description uses; a match on these says nothing about the topic.
  'random', 'data', 'basic', 'basics', 'programming', 'master', 'advanced', 'topics', 'work', 'working', 'developer', 'developers', 'beginner', 'beginners', 'skills', 'scratch', 'online', 'major', 'years', 'used', 'powered', 'learning', 'hands', 'interactive', 'explore']);
const contentWords = (t: string) => t.toLowerCase().replace(/['’]s\b/g, '').split(/[^a-z0-9+#]+/).filter((w) => w.length >= 3 && !ANCHOR_STOP.has(w));

// An anchor relates to the course when one of its content words (or a word with the same 5-letter stem)
// appears in the course's title or description.
export function relatesToCourse(anchor: string, info: string, language = ''): boolean {
  // Naming the language the course teaches counts ("R's stats package" for an R course).
  // Only a noun phrase that names the language or one of its features counts: "base R", "R code",
  // "R functions", "R's stats package". A clause that merely contains "R" doesn't.
  const lang = language.trim();
  if (lang && lang !== 'none') {
    const esc = lang.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flags = lang.length <= 2 ? '' : 'i';
    const feature = '(?:code|programming|functions?|packages?|library|libraries|scripts?|syntax|data frames?|vectors?|lists?|language|console|environment)';
    const named = new RegExp(`^(?:base ${esc}|${esc} ${feature}|${esc}['’]s (?:[a-z]+ ){0,2}${feature}|(?:the )?${esc} (?:[a-z]+ ){0,1}${feature})$`, flags);
    if (named.test(anchor.trim()) && new RegExp(`(^|[^A-Za-z])${esc}(?![A-Za-z])`, flags).test(info)) return true;
  }
  const topic = contentWords(info);
  if (!topic.length) return true;
  const stems = new Set(topic.map((w) => w.slice(0, 5)));
  return contentWords(anchor).some((w) => stems.has(w.slice(0, 5)));
}

function insideInlineCode(text: string, offset: number): boolean {
  return (text.slice(0, offset).match(/`/g) || []).length % 2 === 1;
}

// Anchors that say nothing about what the link teaches ("the first method", "this approach").
const GENERIC_ANCHOR_RE = /^(the|this|that|these|those|a|an|our|its)?\s*(first|second|third|last|next|previous|following|above|below|same|other|default)?\s*(method|methods|step|steps|approach|approaches|way|ways|one|option|options|section|example|examples|program|code|result|results|here|it)$/i;

function placeCourseLink(md: string, s: { line: number; start: number; text: string }, anchor: string, url: string, info = '', language = ''): string | null {
  const a = anchor.trim();
  if (info && !relatesToCourse(a, info, language)) return null;
  if (!a || a.split(/\s+/).length > 5 || isCourseNameAnchor(a, url) || GENERIC_ANCHOR_RE.test(a)) return null;
  // Fragments read badly as links: a possessive ("running R's"), a verb phrase ("running …", "using …"),
  // or an anchor that only modifies the inline code right after it ("[Base R] `stats::kmeans()`").
  if (/['’]s$/i.test(a) || /^(running|using|calling|applying|setting|passing|making|getting|trying|doing|creating|writing|reading|adding|choosing|picking)\b/i.test(a)) return null;
  const afterAnchor = s.text.slice(s.text.indexOf(a) + a.length);
  if (/^\s*`/.test(afterAnchor) || /^['’]s\b/.test(afterAnchor)) return null;
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
export async function weaveCourseLinks(md: string, courseUrls: string[], title: string, language = ''): Promise<{
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
  const infos = new Map<string, string>();
  for (const l of missing) infos.set(l.url, await courseInfo(l.url));
  // Two tries: the second one is told which anchors were rejected and why.
  for (let attempt = 1; attempt <= 2 && todo.length; attempt++) {
    prompt = edpressoCourseLinkPrompt({
      title,
      tasks: todo.map((l) => `- ${l.url} (teaches: ${infos.get(l.url) || courseTopic(l.url)})`).join('\n'),
      sentences: candidates.map((c, i) => `${i + 1}. ${c.text}`).join('\n'),
      feedback: attempt === 1 ? '' : `# Rejected earlier (pick different words)\n${(picks.map((p) => `- "${p?.anchor}" in sentence ${p?.sentence}: ${p?._why || 'not usable'}`).join('\n'))}${used.size ? `\n\nSentences that already hold a course link (choose any other): ${candidates.map((c, i) => (used.has(c.line) ? i + 1 : 0)).filter(Boolean).join(', ')}` : ''}`,
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
        if (applied.some((a) => normWords(a.anchor) === normWords(anchor))) { pick._why = 'same anchor as another course link'; continue; }
        const next = placeCourseLink(d, candidates[n], anchor, l.url, infos.get(l.url) || '', language);
        if (next) { d = next; used.add(candidates[n].line); applied.push({ url: l.url, sentence: candidates[n].text, anchor }); break; }
        pick._why = /[`*]/.test(anchor) ? 'contains inline code or bold'
          : !relatesToCourse(anchor, infos.get(l.url) || '', language) ? 'does not name anything the course teaches (see its description)'
          : !candidates[n].text.includes(anchor.trim()) ? 'not copied exactly from the sentence'
          : 'too generic, too long, or names the course';
      }
    }
    const linked = new Set(applied.map((a) => a.url));
    todo = todo.filter((l) => !linked.has(l.url));
  }
  // Last resort for a course about the language itself: link a phrase that names the language ("base R",
  // "R code", "R functions", "Python packages") in a sentence that has none yet.
  if (todo.length && language) {
    const esc = language.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flags = language.length <= 2 ? 'g' : 'gi';
    const phraseRe = new RegExp(`\\b(?:base ${esc}|${esc} (?:code|programming|functions?|packages?|scripts?|data frames?|vectors?|syntax))\\b`, flags);
    for (const l of todo) {
      for (const c of candidates) {
        if (used.has(c.line)) continue;
        const m = [...c.text.matchAll(phraseRe)].find((x) => !insideInlineCode(c.text, x.index!) && !applied.some((a) => normWords(a.anchor) === normWords(x[0])));
        if (!m) continue;
        const next = placeCourseLink(d, c, m[0], l.url, infos.get(l.url) || '', language);
        if (next) { d = next; used.add(c.line); applied.push({ url: l.url, sentence: c.text, anchor: m[0], fallback: true }); break; }
      }
    }
  }
  // Course links are required. Still missing: one existing sentence is rewritten minimally so it names
  // something the course teaches, then the link goes on that phrase (two tries, with the reasons).
  {
    const linkedNow = new Set(applied.map((a) => a.url));
    for (const l of todo.filter((x) => !linkedNow.has(x.url))) {
      let feedback = '';
      for (let attempt = 1; attempt <= 2; attempt++) {
        const cands = linkableSentences(d).filter((c) => !used.has(c.line));
        if (!cands.length) break;
        const rwPrompt = edpressoCourseLinkRewritePrompt({
          title, course: `- ${l.url} (teaches: ${infos.get(l.url) || courseTopic(l.url)})`,
          sentences: cands.map((c, i) => `${i + 1}. ${c.text}`).join('\n'), feedback,
        });
        let pick: any = {};
        try { pick = parseJsonLoose(await openaiJSON(rwPrompt)); } catch (e: any) { if (getAbortSignal()?.aborted) throw e; }
        const c = cands[Number(pick?.sentence) - 1];
        const rewritten = String(pick?.rewritten || '').trim();
        const anchor = String(pick?.anchor || '').trim();
        const keep = (t: string) => [...t.matchAll(/`[^`]*`|\]\([^)]*\)|#key#/g)].map((m) => m[0]).sort().join('|');
        const why = !c ? 'no such sentence'
          : !rewritten || !anchor ? 'empty answer'
          : rewritten.split(/\s+/).length > c.text.split(/\s+/).length + 12 ? 'too much longer than the original'
          : /[.!?]\s+[A-Z]/.test(rewritten.replace(/`[^`]*`/g, '')) ? 'became more than one sentence'
          : keep(rewritten) !== keep(c.text) ? 'changed inline code, links, or popups'
          : EXPLICIT_CTA_RE.test(rewritten) || POINTER_RE.test(rewritten) ? 'reads as an advert'
          : rewritten.split(anchor).length !== 2 ? 'anchor not found exactly once'
          : applied.some((a) => normWords(a.anchor) === normWords(anchor)) || /\]\(/.test(d) && [...d.matchAll(MD_LINK_RE)].some((m) => !m[1] && normWords(m[2]) === normWords(anchor)) ? 'same anchor as another link; use a different phrase'
          : '';
        if (!why) {
          const lines = d.split('\n');
          lines[c.line] = lines[c.line].slice(0, c.start) + lines[c.line].slice(c.start).replace(c.text, () => rewritten);
          const updated = lines.join('\n');
          const target = linkableSentences(updated).find((x) => x.line === c.line && x.text.includes(anchor));
          const next = target ? placeCourseLink(updated, target, anchor, l.url, infos.get(l.url) || '', language) : null;
          if (next) { d = next; used.add(c.line); applied.push({ url: l.url, sentence: rewritten, anchor, rewritten: true }); break; }
          feedback = `# Rejected earlier\n- "${anchor}": it must be a short noun phrase naming something the course teaches (as its description says), outside inline code and not right before it.`;
        } else {
          feedback = `# Rejected earlier\n- sentence ${pick?.sentence}: ${why}.`;
        }
      }
    }
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

// After a prose-only rewrite (trim, coverage), the programs that were run and checked go back in exactly,
// tag by tag, so a rewrite that touched code is repaired instead of thrown away.
export function restoreCode(out: string, original: string): string {
  const want = codeTags(original);
  if (!want.length || codeTags(out).length !== want.length) return out;
  let i = 0;
  return out.replace(CODE_TAG_RE, (tag) => {
    const code = want[i++].code;
    return tag.replace(FENCE_IN_TAG_RE, (_m: string, open: string, _c: string, close: string) => `${open}${code}\n${close}`);
  });
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

// A variable named after a built-in function (R's c(), Python's list()) works but teaches a bad habit.
const SHADOWABLE: Record<string, { names: string[]; assign: (n: string) => RegExp }> = {
  r: { names: ['c', 't', 'T', 'F', 'df', 'data', 'list', 'mean', 'sum', 'max', 'min', 'length', 'names', 'matrix', 'vector'], assign: (n) => new RegExp(`(^|[\\s;({])${n}\\s*(<-|=(?!=))`, 'm') },
  python: { names: ['list', 'dict', 'str', 'sum', 'max', 'min', 'id', 'type', 'input', 'len', 'set', 'map', 'filter', 'object', 'range'], assign: (n) => new RegExp(`(^|[\\s;(,])${n}\\s*=(?!=)`, 'm') },
};
export function shadowedBuiltin(language: string, code: string): string | null {
  const spec = SHADOWABLE[String(language).toLowerCase()];
  if (!spec) return null;
  // Ignore named arguments inside calls such as kmeans(x, centers = 3) by checking line starts only for "=".
  for (const n of spec.names) {
    const lineStart = new RegExp(`^\\s*${n}\\s*(<-|=(?!=))`, 'm');
    if (lineStart.test(code)) return n;
  }
  return null;
}

// The "**Line N:**" explanation belongs directly under its program: move it up when output notes, an image,
// or a note got between them.
export function moveLineExplanations(md: string): string {
  const tags = [...md.matchAll(CODE_TAG_RE)];
  let out = md;
  for (let i = tags.length - 1; i >= 0; i--) {
    const end = tags[i].index! + tags[i][0].length;
    const nextTag = tags[i + 1]?.index ?? out.length;
    let section = out.slice(end, nextTag);
    const stop = section.search(/^#{2,3}\s/m);
    if (stop >= 0) section = section.slice(0, stop);
    const block = section.match(/(?:^|\n)((?:[ \t]*\*\*Lines?\s+\d+[^\n]*(?:\n|$))+)/);
    if (!block) continue;
    const before = section.slice(0, block.index!);
    if (!before.trim()) continue; // already directly under the code
    const explanation = block[1].replace(/\s+$/, '');
    const rest = section.replace(block[1], '').replace(/\n{3,}/g, '\n\n');
    out = `${out.slice(0, end)}\n\n${explanation}\n\n${rest.replace(/^\s+/, '')}${out.slice(end + section.length)}`;
  }
  return out.replace(/\n{3,}/g, '\n\n');
}

const SUBSCRIPTS: Record<string, string> = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9', 'ₖ': 'k', 'ᵢ': 'i', 'ⱼ': 'j', 'ₙ': 'n', 'ₘ': 'm' };
// One notation in prose: "C₁" becomes "C_1", matching "C_K".
export function unifySubscripts(md: string): string {
  const lines = md.split('\n');
  const kinds = classifyLines(lines);
  return lines.map((l, i) => (kinds[i] === 'block' ? l : l.replace(/([A-Za-zμσλα-ω])([₀-₉ₖᵢⱼₙₘ]+)/g, (_m, base, sub) => `${base}_${[...sub].map((c) => SUBSCRIPTS[c] || c).join('')}`))).join('\n');
}

// A heading that only labels the widget under it ("## Quiz", "## FAQ") duplicates the widget's own title.
export function dropWidgetHeadings(md: string): string {
  return md.replace(/^#{2,3}\s*(quiz|faqs?|frequently asked questions|pause and think|test your (knowledge|understanding))\s*\n+(?=\s*(\[\[(Quiz|FAQ|Pause and think) widget\]\]|EDPWIDGET\d+TOKEN))/gim, '');
}

// FAQs that ask the same thing in other words: the later one goes (author FAQs are listed first).
export function dedupeFaqs(md: string, keep: string[] = []): string {
  return md.replace(/\[\[FAQ widget\]\]([\s\S]*?)\[\[\/FAQ widget\]\]/, (m, body: string) => {
    const pairs = body.split(/\n(?=\s*Q:)/).map((p) => p.trim()).filter((p) => /^Q:/.test(p));
    const SYN: Record<string, string> = { argument: 'param', parameter: 'param', option: 'param', setting: 'param', arg: 'param', mean: 'means', function: '', clustering: '', algorithm: '', method: '' };
    const words = (q: string) => new Set(normWords(q.replace(/^Q:\s*/, '').split('\n')[0])
      .replace(/\bk means\b/g, 'kmeans')
      .split(' ')
      .map((w) => (w in SYN ? SYN[w] : w.replace(/s$/, '')))
      .filter((w) => w.length >= 3 && !['what', 'doe', 'does', 'how', 'the', 'and', 'for', 'with', 'you', 'should', 'use', 'mean'].includes(w)));
    const isAuthor = (p: string) => keep.some((q) => normWords(q) === normWords(p.replace(/^Q:\s*/, '').split('\n')[0]));
    const out: string[] = [];
    for (const p of pairs) {
      const w = words(p);
      const dup = out.find((o) => { const v = words(o); const inter = [...w].filter((x) => v.has(x)).length; return inter / Math.max(1, Math.min(w.size, v.size)) >= 0.8; });
      if (dup && !isAuthor(p)) continue;
      out.push(p);
    }
    return `[[FAQ widget]]\n${out.join('\n\n')}\n[[/FAQ widget]]`;
  });
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

// What the body commits to, for checking the Quiz and FAQ against it: the direct answer, the key
// takeaways, and every sentence that recommends a value or states a default.
function answerFacts(md: string): string {
  const lines = md.split('\n');
  const kinds = classifyLines(lines);
  const first = lines.find((l, i) => kinds[i] === 'prose' && !/^\s*>/.test(l)) || '';
  const takeaways = lines.filter((l) => /^\s*>\s*-/.test(l));
  const recs: string[] = [];
  lines.forEach((l, i) => {
    if (kinds[i] !== 'prose' && kinds[i] !== 'list') return;
    for (const m of l.matchAll(/[^.!?]*\b(recommend\w*|default|use|set|between|at least|or more|typical\w*|common\w*)\b[^.!?]*\d[^.!?]*[.!?]/gi)) recs.push(m[0].trim());
  });
  return [first, ...takeaways, ...[...new Set(recs)].slice(0, 12).map((r) => `- ${r}`)].filter(Boolean).join('\n').slice(0, 3000) || '(none)';
}

// ---- Math: LaTeX belongs in LaTeX widgets, one formula each; prose gets plain symbols. ----

const LATEX_SYMBOLS: [RegExp, string][] = [
  [/\\mu(?![a-zA-Z])/g, 'μ'], [/\\sigma(?![a-zA-Z])/g, 'σ'], [/\\Sigma(?![a-zA-Z])|\\sum(?![a-zA-Z])/g, 'Σ'], [/\\lambda(?![a-zA-Z])/g, 'λ'], [/\\alpha(?![a-zA-Z])/g, 'α'],
  [/\\beta(?![a-zA-Z])/g, 'β'], [/\\theta(?![a-zA-Z])/g, 'θ'], [/\\pi(?![a-zA-Z])/g, 'π'], [/\\epsilon(?![a-zA-Z])|\\varepsilon(?![a-zA-Z])/g, 'ε'], [/\\delta(?![a-zA-Z])/g, 'δ'],
  [/\\lVert|\\rVert|\\\|/g, '‖'], [/\\in(?![a-zA-Z])/g, '∈'], [/\\leq?(?![a-zA-Z])/g, '≤'], [/\\geq?(?![a-zA-Z])/g, '≥'], [/\\neq(?![a-zA-Z])/g, '≠'],
  [/\\cdot(?![a-zA-Z])/g, '·'], [/\\times(?![a-zA-Z])/g, '×'], [/\\approx(?![a-zA-Z])/g, '≈'], [/\\l?dots(?![a-zA-Z])|\\cdots(?![a-zA-Z])/g, '…'], [/\\infty(?![a-zA-Z])/g, '∞'],
];

function plainMath(tex: string): string {
  let t = tex.trim();
  for (const [re, sym] of LATEX_SYMBOLS) t = t.replace(re, sym);
  return t.replace(/\\(text|mathrm|operatorname|mathbf)\{([^}]*)\}/g, '$2').replace(/\\[a-zA-Z]+/g, '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}

// "\( x_i \)" in prose shows as raw characters in Educative text blocks: make it inline code with plain symbols.
export function fixInlineLatex(md: string): string {
  const lines = md.split('\n');
  const kinds = classifyLines(lines);
  // Inline code that holds a LaTeX symbol command (`\\mu_k`) gets plain symbols too; other backslashes
  // in code (such as "\\n") are left alone.
  const symbolCmd = new RegExp(LATEX_SYMBOLS.map(([re]) => re.source).join('|'));
  return lines.map((l, i) => (kinds[i] === 'block' ? l : l
    .replace(/\\\((.+?)\\\)/g, (_m, tex) => `\`${plainMath(tex)}\``)
    // "$C_1$" in prose (outside inline code; only math-looking spans, so prices and R's x$y are left alone).
    .split(/(`[^`\n]*`)/).map((seg) => (seg.startsWith('`') ? seg : seg.replace(/\$([^$\n]{1,60})\$/g, (m, tex) => (/[\\_^]/.test(tex) && !/\s{2,}/.test(tex) ? `\`${plainMath(tex)}\`` : m)))).join('')
    .replace(/`([^`\n]+)`/g, (m, inner) => {
      if (!symbolCmd.test(inner)) return m;
      let t = inner;
      for (const [re, sym] of LATEX_SYMBOLS) t = t.replace(re, sym);
      return `\`${t.replace(/[{}]/g, '')}\``;
    }))).join('\n');
}

// A LaTeX widget holding several formulas (one per line, no environment) becomes one widget per formula,
// when each line renders on its own.
export function splitLatexWidgets(md: string): string {
  return md.replace(/\[\[LaTeX widget\]\]([\s\S]*?)\[\[\/LaTeX widget\]\]/gi, (m, body: string) => {
    if (/\\begin\{/.test(body)) return m;
    const parts = body.split('\n')
      .map((l) => l.trim().replace(/(,|;)?\s*(\\q?quad\s*)+$/, '').replace(/[,;]\s*$/, '').trim())
      .filter(Boolean);
    if (parts.length < 2) return m;
    try { parts.forEach((f) => katex.renderToString(f, { displayMode: true, throwOnError: true })); } catch { return m; }
    return parts.map((f) => `[[LaTeX widget]]\n${f}\n[[/LaTeX widget]]`).join('\n\n');
  });
}

// A numbered list right before a Slides widget repeats its steps; the slides carry them.
export function removeListBeforeSlides(md: string): string {
  return md.replace(/(^|\n\n)((?:[ \t]*\d+\.\s[^\n]*\n?){3,})\n*(?=\[\[Slides widget\]\])/g, '$1');
}

// The exact keyword is never bolded, and template placeholders never ship ("— Name, role").
export function cleanPlaceholders(md: string, phrases: string | string[]): string {
  // No search phrase (the keyword or a related query) is ever bolded.
  const wanted = new Set((Array.isArray(phrases) ? phrases : [phrases]).map(normWords).filter(Boolean));
  let out = md.replace(/\*\*([^*\n]{3,80})\*\*/g, (m, inner) => (wanted.has(normWords(inner)) ? inner : m));
  return out
    .replace(/,\s*(role|title|position|<role>|\[role\])\s*$/gim, '')
    .replace(/\s*\((role|TBD|TODO)\)/g, '')
    .replace(/<(name|role|source|person)>/gi, '');
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
  // A heading that forces the phrase into "What is …?" when the phrase is a task ("… using the nstart
  // parameter", "how to …") reads as keyword stuffing; it is rewritten even if it is the only one.
  // A heading that is just the phrase (it repeats the title) is rewritten too.
  // So is one that wraps the phrase in extra words that repeat its own words ("What does nstart do in
  // K-means clustering in R using the nstart parameter?").
  const phraseWords = new Set(normWords(phrase).split(' ').filter((w) => w.length >= 3));
  const repeatsPhraseWord = (h: string) => {
    const rest = normWords(h.replace(/^#+\s*/, '')).replace(normWords(phrase), ' ').split(' ').filter((w) => w.length >= 3);
    return rest.some((w) => phraseWords.has(w));
  };
  const forced = (h: string) => (/^#{2,3}\s*what\s+(is|are)\b/i.test(h) && /\b(using|with|via)\b|^how\s+to\b/i.test(phrase.trim()))
    || normWords(h.replace(/^#+\s*/, '')) === normWords(phrase)
    || repeatsPhraseWord(h);
  const keepHeading = uses.find((u) => u.kind === 'heading' && /^##\s/.test(lines[u.line]) && !forced(lines[u.line]));
  return { uses, extra: uses.filter((u) => u !== keepProse && u !== keepHeading) };
}

// True when the original text already bolded these words (a label such as "**Note:**" stays bold).
function from_has_bold(original: string, inner: string): boolean {
  return original.includes(`**${inner}**`);
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
    // Rewrites are never bolded: a bolded search phrase in a sentence reads as stuffing.
    let to = String(picks.find((p) => Number(p?.n) === i + 1)?.text || '').trim()
      .replace(/\*\*([^*]+)\*\*/g, (m, inner) => (from_has_bold(u.text, inner) ? m : inner));
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
      tags: (Array.isArray(parsed.tags) ? parsed.tags : [])
        .map((t: any) => String(t).toLowerCase().trim().replace(/[^a-z0-9+#.]+/g, '-').replace(/^-+|-+$/g, ''))
        .filter(Boolean).slice(0, 5) as string[],
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
    ? 'A closing of one or two sentences under a short "##" heading (for example "## Choosing a value"), placed between the Quiz and the FAQ: a decision rule the reader can act on (for example "Use nstart = 25; raise it if tot.withinss still changes across seeds"), never a summary of the takeaways. It is the only section about choosing a value: don\'t also write a body section that gives the same rule. No headings for the Quiz or FAQ themselves (no "## Quiz", "## FAQ").'
    : 'A short closing section (1–3 sentences) with a meaningful heading that adds a decision rule or the next step, without restating the key takeaways. No call to action and no pointer to a course or path. It sits between the Quiz and the FAQ, so they are never back to back.';
  const primaryKeyword = classified.primaryKeyword || title;
  // Educative tags: the author's keywords when given, otherwise the classifier's topic tags. Programming
  // tags (the language plus the most specific topics) are what Educative's own Answers carry.
  const answerTags = keywords.length ? keywords.slice(0, 5) : classified.tags;
  const programmingTags = [...new Set([
    ...(classified.language && classified.language !== 'none' ? [classified.language.toLowerCase().replace(/\s+/g, '-')] : []),
    ...classified.tags,
  ])].slice(0, 4);
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

  // 2b) FAQ check — People-also-ask questions are ranked by relevance to this Answer's exact question.
  // Author FAQs are always kept, word for word. Wording is never changed.
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
      // Every author FAQ is kept, word for word, whatever its topic: the author asked for it. Only the
      // People-also-ask candidates are filtered and ranked (and never repeat an author FAQ).
      result.kept = userFaqs;
      const cands: any[] = Array.isArray(parsed.candidates) ? parsed.candidates : [];
      result.candidates = cands
        .filter((c) => Number(c?.relevance) >= 4 && paaQuestions[Number(c?.n) - 1])
        .sort((a, b) => Number(b.relevance) - Number(a.relevance))
        .map((c) => paaQuestions[Number(c.n) - 1])
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
      faqTarget: `Every author FAQ is included no matter how many there are or how broad they are. Then add candidates until there are about ${narrow ? '5–8' : '8–12'} FAQs in total (add none when the author FAQs already reach that).`,
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

  const searchPhrases = [primaryKeyword, ...keywords, ...researchList(research, 'Related keywords')];
  // Applied after the writer and the reviewer: no line-number comments in code, no unconfirmed quotes,
  // and no Terminal widget on a topic that is not done on the command line.
  const cleanDraft = (md: string) => {
    let out = moveLineExplanations(unifySubscripts(normalizeKeywordSyntax(cleanPlaceholders(removeListBeforeSlides(splitLatexWidgets(fixInlineLatex(stripLineMarkers(md)))), searchPhrases))));
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
      const prompt = edpressoWidgetReviewPrompt({ title, language: languageStr, keywords: keywordsStr, verifiedLinks: verifiedLinksStr, answerFacts: answerFacts(d), widgets: tail });
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
    // Outputs of the programs as written, so each program can be compared with the earlier ones.
    const earlierOutputs: string[] = (await mapLimit(tags, 3, (t) => run(t.language, t.code))).map((r) => (r.ok ? r.stdout.trim() : ''));
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
      const others = tags.filter((_o, j) => j !== i)
        .map((o) => `- ${o.caption || '(no caption)'}\n${o.code.split('\n').slice(0, 14).join('\n')}`).join('\n\n') || '(none)';
      for (let attempt = 1; attempt <= 3; attempt++) {
        const prompt = edpressoCodeVerdictPrompt({
          title, language: t.language, context, others, program: numberedListing(code), output: outputText(result),
          attempt: attempt === 1 ? '' : `This is attempt ${attempt}: an earlier fix still did not show the effect.`,
        });
        let verdict: any = {};
        try { verdict = parseJsonLoose(await openaiJSON(prompt)); } catch (e: any) { if (getAbortSignal()?.aborted) throw e; }
        // Checks code can make on its own: the same output as an earlier program (a repeated experiment),
        // or one line printed again and again (print each distinct warning once).
        const lines = result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
        const maxRepeat = Math.max(0, ...[...new Set(lines)].map((l) => lines.filter((x) => x === l).length));
        const duplicateOf = earlierOutputs.findIndex((o, j) => j < i && o && o === result.stdout.trim());
        const shadow = shadowedBuiltin(t.language, code);
        if (shadow) verdict = { ...verdict, shows: false, problem: `${verdict?.problem || ''} The program assigns to \`${shadow}\`, which overwrites a built-in function; rename the variable.`.trim() };
        if (maxRepeat >= 3) verdict = { ...verdict, shows: false, problem: `${verdict?.problem || ''} The output prints the same line ${maxRepeat} times; collect the messages and print each distinct one once.`.trim() };
        if (duplicateOf >= 0) verdict = { ...verdict, shows: false, problem: `${verdict?.problem || ''} It prints exactly what program ${duplicateOf + 1} prints, so it repeats that experiment; show something different that the text around it describes.`.trim() };
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

    // A program that never showed its point (or still fails) is removed with its line explanation; the
    // text step then removes the sentences that introduced it. The first program (basic usage) always stays.
    const dropped: { program: number; caption: string; problem: string }[] = [];
    const failedIdx = programs.filter((p) => p.index > 0 && p.result.ran && p.attempts.length && !p.attempts.some((a: any) => a.shows)).map((p) => p.index);
    if (failedIdx.length) {
      const current = codeTags(body);
      for (const i of [...failedIdx].sort((a, b) => b - a)) {
        const t = current[i];
        if (!t) continue;
        let end = t.end;
        const after = body.slice(end);
        const expl = after.match(/^\s*((?:[ \t]*\*\*Lines?\s+\d+[^\n]*(?:\n|$))+)/);
        if (expl) end += expl[0].length;
        dropped.push({ program: i + 1, caption: t.caption, problem: String(programs[i].attempts.slice(-1)[0]?.problem || '') });
        body = `${body.slice(0, t.start).replace(/\s+$/, '')}\n\n${body.slice(end).replace(/^\s+/, '')}`;
      }
      for (const i of failedIdx) programs[i] = { ...programs[i], dropped: true } as any;
    }
    const kept = programs.filter((p: any) => !p.dropped);

    // (B) Text: agree with the real output; fix line references and names. The code is final here.
    const refs = lineRefProblems(body);
    const report = codeTags(body).map((t, i) => {
      const p = kept[i];
      return `## Program ${i + 1} (${t.language})${t.caption ? `: ${t.caption}` : ''}${p.changed ? ' — rewritten so its output shows the effect; update the text that describes it' : ''}\n\`\`\`\n${numberedListing(t.code)}\n\`\`\`\n${outputText(p.result)}\nLine-reference problems: ${refs[i].join('; ') || 'none found'}`;
    }).join('\n\n') + (dropped.length ? `\n\n## Programs removed (they never showed their point)\n${dropped.map((x) => `- "${x.caption}": ${x.problem}`).join('\n')}\nDelete or rewrite the sentences that introduced, explained, or quoted the output of these programs; don't mention them.` : '');
    const needsText = dropped.length > 0 || programs.some((p) => p.changed || (p.result.ran && !p.result.ok)) || refs.some((r) => r.length) || programs.some((p) => p.result.ran);
    let textAccepted = false;
    if (needsText) {
      const prompt = edpressoCodeCheckPrompt({
        title, language: languageStr, wordBudget: spec.budget, currentWordCount: String(countBodyWords(body)), report, draft: body,
      });
      const out = moveLineExplanations(stripLineMarkers(normalizeImageTags(sanitizeText(await generateText(prompt, { maxTokens: 16000 }))).trim()));
      const sameCode = codeTags(out).map((t) => t.code.trim()).join('\n#--#\n') === codeTags(body).map((t) => t.code.trim()).join('\n#--#\n');
      const tokensKept = blocks.every((_b, i) => out.includes(`EDPWIDGET${i}TOKEN`));
      textAccepted = isSafeRewrite(body, out) && sameCode && tokensKept;
      if (textAccepted) body = out;
      stageLog('code-check-text', prompt, { programs: tags.length, sameCode }, out);
    }
    draft = restoreWidgets(body, blocks);
    const final = codeTags(draft).map((t, i) => ({
      program: i + 1, language: t.language, caption: t.caption, changed: kept[i]?.changed || false,
      ran: kept[i]?.result.ran, ok: kept[i]?.result.ok, reason: kept[i]?.result.reason,
      shows: kept[i]?.attempts.some((a: any) => a.shows) ?? null,
      stdout: (kept[i]?.result.stdout || '').slice(0, 1500), stderr: (kept[i]?.result.stderr || '').slice(0, 600),
    }));
    const payload = { programs: programs.map((p) => ({ program: p.index + 1, changed: p.changed, attempts: p.attempts, dropped: !!(p as any).dropped })), dropped, textAccepted, final, lineRefProblems: lineRefProblems(draft) };
    emit({ type: 'data', name: 'code-check', payload });
    return payload;
  });

  // 6b2) Coverage — every fact the outline marked mustCover (defaults, ignored-argument cases, the most
  // searched warning) is stated in the body, not only in the Quiz or FAQ. Code is never changed here.
  const coverage = await stage('coverage', async () => {
    const must: string[] = (Array.isArray(outline?.mustCover) ? outline.mustCover : []).map((x: any) => String(x).trim()).filter(Boolean).slice(0, 8);
    if (!must.length) return { skipped: 'nothing planned', missing: [] as string[], added: false };
    const { body, blocks } = protectWidgets(draft);
    const checkPrompt = edpressoCoverageCheckPrompt({ title, items: must.map((m, i) => `${i + 1}. ${m}`).join('\n'), draft: body });
    let missingIdx: number[] = [];
    try {
      const parsed: any = parseJsonLoose(await openaiJSON(checkPrompt));
      missingIdx = (Array.isArray(parsed?.missing) ? parsed.missing : []).map(Number).filter((n: number) => n >= 1 && n <= must.length);
    } catch (e: any) { if (getAbortSignal()?.aborted) throw e; }
    const missing = [...new Set(missingIdx)].map((n) => must[n - 1]);
    stageLog('coverage-check', checkPrompt, { must }, { missing });
    let added = false;
    if (missing.length) {
      const fixPrompt = edpressoCoverageFixPrompt({
        title, missing: missing.map((m) => `- ${m}`).join('\n'), wordBudget: spec.budget, currentWordCount: String(countBodyWords(body)), draft: body,
      });
      const out = restoreCode(cleanDraft(normalizeImageTags(sanitizeText(await generateText(fixPrompt, { maxTokens: 16000 }))).trim()).markdown, body);
      const sameCode = codeTags(out).map((t) => t.code.trim()).join('\n#--#\n') === codeTags(body).map((t) => t.code.trim()).join('\n#--#\n');
      const tokensKept = blocks.every((_b, i) => out.includes(`EDPWIDGET${i}TOKEN`));
      const count = (md: string, re: RegExp) => (md.match(re) || []).length;
      const widgetsKept = count(out, /\[\[[A-Za-z ]+ widget\]\]/g) === count(body, /\[\[[A-Za-z ]+ widget\]\]/g) && count(out, /\[image\]/g) === count(body, /\[image\]/g);
      added = isSafeRewrite(body, out) && sameCode && tokensKept && widgetsKept;
      if (added) draft = restoreWidgets(out, blocks);
      stageLog('coverage-fix', fixPrompt, { missing }, { added, sameCode, tokensKept, widgetsKept });
    }
    const result = { must, missing, added };
    emit({ type: 'data', name: 'coverage', payload: result });
    return result;
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

  // 6a) Author FAQs — every FAQ the author gave is in the FAQ widget, word for word. Any the draft left out
  // is added back (at the top, in the author's order) with an answer written for it.
  await stage('author-faqs', async () => {
    const present = new Set(faqQuestions(draft).map(normQuestion));
    const missing = authorFaqs.filter((q) => !present.has(normQuestion(q)));
    if (!missing.length) return { missing: [] as string[] };
    const prompt = edpressoFaqAnswerPrompt({ title, language: languageStr, questions: missing.map((q, i) => `${i + 1}. ${q}`).join('\n') });
    let answers: any[] = [];
    try { answers = (parseJsonLoose(await openaiJSON(prompt)) as any)?.answers || []; } catch (e: any) { if (getAbortSignal()?.aborted) throw e; }
    const pairs = missing.map((q, i) => {
      const a = String(answers.find((x: any) => Number(x?.n) === i + 1)?.answer || '').trim();
      return `Q: ${q}\nA: ${a || 'See the sections above for details.'}`;
    }).join('\n\n');
    draft = /\[\[FAQ widget\]\]/.test(draft)
      ? draft.replace(/\[\[FAQ widget\]\]\s*/, () => `[[FAQ widget]]\n${pairs}\n\n`)
      : `${draft}\n\nHere are answers to common questions.\n\n[[FAQ widget]]\n${pairs}\n[[/FAQ widget]]`;
    stageLog('author-faqs', prompt, { missing }, { answers });
    emit({ type: 'data', name: 'author-faqs', payload: { missing } });
    return { missing };
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
      // Short language names are matched case-sensitively ("R"), so pass them uppercased.
      ? await weaveCourseLinks(pointers.markdown, courseLinks, title, classified.language.length <= 2 ? classified.language.toUpperCase() : classified.language)
      : { markdown: pointers.markdown, links: [] as CourseLinkStatus[], removedSentences: [] as string[], applied: [] as any[] };
    if ('prompt' in woven && woven.prompt) stageLog('course-links', woven.prompt, { links: courseLinks }, { picks: (woven as any).picks, applied: woven.applied });
    // Course links never belong in the Quiz or FAQ.
    const cleanBlocks = blocks.map((b) => b.replace(MD_LINK_RE, (m, bang, text, href) => (courseLinks.some((u) => normalizeUrl(u) === normalizeUrl(stripTracking(href))) ? text : m)));
    draft = restoreWidgets(woven.markdown, cleanBlocks);
    const removedSentences = [...pointers.removed, ...woven.removedSentences];
    emit({ type: 'data', name: 'course-links', payload: { links: woven.links, removedSentences, applied: woven.applied } });
    return woven.links;
  });

  // 7a2) Docs check — statements (body, Quiz, FAQ) that contradict the official documentation are corrected.
  const docCheck = await stage('doc-check', async () => {
    // Only documentation about this topic: a page that shares words with the title or keyword.
    const topic = new Set(contentWords(`${title} ${primaryKeyword}`));
    const docs = verifiedLinks.filter((l) => l.kind === 'external')
      .map((l) => ({ l, score: contentWords(`${l.title} ${l.topic} ${l.url.replace(/[-/_.]/g, ' ')}`).filter((w) => topic.has(w)).length }))
      .filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 2).map((x) => x.l);
    if (!docs.length) return { skipped: 'no official documentation found', corrections: [] as any[] };
    const texts = (await Promise.all(docs.map(async (l) => ({ url: l.url, text: (await fetchPageText(l.url)).replace(/\s+/g, ' ').trim() }))))
      .filter((d) => d.text.length > 200);
    if (!texts.length) return { skipped: 'documentation could not be read', corrections: [] as any[] };
    const docsStr = texts.map((d) => `## ${d.url}\n${d.text.slice(0, 14000)}`).join('\n\n');
    const prompt = edpressoDocCheckPrompt({ title, docs: docsStr, answer: draft });
    let parsed: any = {};
    try { parsed = parseJsonLoose(await openaiJSON(prompt)); } catch (e: any) { if (getAbortSignal()?.aborted) throw e; }
    const applied: any[] = [];
    const skipped: any[] = [];
    for (const c of (Array.isArray(parsed?.corrections) ? parsed.corrections : [])) {
      const wrong = String(c?.wrong || '').trim();
      const correct = String(c?.correct || '').trim();
      const count = wrong ? draft.split(wrong).length - 1 : 0;
      const inCode = codeTags(draft).some((t) => t.code.includes(wrong));
      if (!wrong || !correct || count !== 1 || inCode || correct.length > wrong.length * 1.5 + 40) { skipped.push({ wrong, why: !count ? 'not found' : count > 1 ? 'ambiguous' : inCode ? 'inside code' : 'bad replacement' }); continue; }
      draft = draft.replace(wrong, () => correct);
      applied.push({ wrong, correct, reason: c?.reason });
    }
    const result = { docs: texts.map((d) => d.url), corrections: applied, skipped };
    stageLog('doc-check', prompt, { docs: texts.map((d) => d.url) }, result);
    emit({ type: 'data', name: 'doc-check', payload: result });
    return result;
  });

  // 7b2) Body links — every Answer links its closest verified Educative Answer and the official docs. If the
  // writer's links were lost along the way, the most relevant ones are placed on existing words.
  const bodyLinkReport = await stage('body-links', async () => {
    const { body, blocks } = protectWidgets(draft);
    const present = [...body.matchAll(MD_LINK_RE)].filter((m) => !m[1]).map((m) => normalizeUrl(stripTracking(m[3])));
    const courseSet = new Set(courseLinks.map(normalizeUrl));
    const topicWords = new Set(contentWords(`${title} ${primaryKeyword}`));
    const score = (l: VerifiedLink) => contentWords(`${l.title} ${l.topic} ${l.url.replace(/[-/]/g, ' ')}`).filter((w) => topicWords.has(w)).length;
    const isPresent = (l: VerifiedLink) => present.includes(normalizeUrl(l.url)) || present.includes(normalizeUrl(l.finalUrl));
    const internal = verifiedLinks.filter((l) => l.kind === 'internal' && !isCoursePage(l.url) && !courseSet.has(normalizeUrl(l.url)));
    const external = verifiedLinks.filter((l) => l.kind === 'external');
    const want: string[] = [];
    if (!internal.some(isPresent)) {
      const best = [...internal].sort((a, b) => score(b) - score(a))[0];
      if (best && score(best) > 0) want.push(best.url);
    }
    if (!external.some(isPresent)) {
      const docs = [...external].sort((a, b) => score(b) - score(a))[0];
      if (docs && score(docs) > 0) want.push(docs.url);
    }
    if (!want.length) return { added: [] as any[], present: present.length };
    const woven = await weaveCourseLinks(body, want, title, classified.language.length <= 2 ? classified.language.toUpperCase() : classified.language);
    draft = restoreWidgets(woven.markdown, blocks);
    const result = { wanted: want, links: woven.links, applied: woven.applied };
    stageLog('body-links', woven.prompt || '', { want }, result);
    emit({ type: 'data', name: 'body-links', payload: result });
    return result;
  });

  // 7c) Related Answers — a Callout that points to the series or prerequisite Answers the author gave,
  // placed where it fits (prerequisites near the top). Links are checked first; the author's sentence is
  // kept word for word.
  const relatedReport = await stage('related-answers', async () => {
    const urls = [...new Set(toList(input.relatedAnswers, /\r?\n/).map(stripTracking)
      .filter((u) => /^https?:\/\/(www\.)?(educative\.io|how\.dev)\/answers\//i.test(u)))].slice(0, MAX_RELATED_ANSWERS);
    if (!urls.length) return { skipped: 'none given' };
    const checked = await Promise.all(urls.map(async (u) => ({ url: u, ok: (await checkUrl(u)).ok, title: await courseInfo(u) })));
    const live = checked.filter((c) => c.ok);
    if (!live.length) return { skipped: 'no related Answer loads', checked };
    const userSentence = String(input.relatedSentence || '').trim();
    const { body, blocks } = protectWidgets(draft);
    const lines = body.split('\n');
    const kinds = classifyLines(lines);
    const headings = lines.filter((l, i) => kinds[i] === 'heading' && /^##\s/.test(l)).map((l) => l.replace(/^#+\s*/, '').trim());
    const prompt = edpressoRelatedCalloutPrompt({
      title,
      answers: live.map((c) => `- ${c.url} (${c.title.split(' — ')[0] || courseTopic(c.url)})`).join('\n'),
      sentence: userSentence || '(none)',
      sections: headings.map((h) => `- ${h}`).join('\n') || '(none)',
    });
    let parsed: any = {};
    try { parsed = parseJsonLoose(await openaiJSON(prompt)); } catch (e: any) { if (getAbortSignal()?.aborted) throw e; }
    let sentence = String(parsed?.sentence || '').trim();
    const linkUrls = [...sentence.matchAll(MD_LINK_RE)].filter((m) => !m[1]).map((m) => normalizeUrl(stripTracking(m[3])));
    const everyOnce = live.every((c) => linkUrls.filter((u) => u === normalizeUrl(c.url)).length === 1) && linkUrls.length === live.length;
    const sameWords = !userSentence || normWords(sentence.replace(MD_LINK_RE, '$2')) === normWords(userSentence);
    if (!sentence || !everyOnce || !sameWords || EXPLICIT_CTA_RE.test(sentence.replace(MD_LINK_RE, '$2')) && !userSentence) {
      // Fallback: the author's sentence (or a plain one) followed by the linked titles.
      const linked = live.map((c) => `[${(c.title.split(' — ')[0] || courseTopic(c.url)).replace(/[[\]]/g, '')}](${c.url})`).join(' and ');
      sentence = userSentence ? `${userSentence} Related: ${linked}.` : `This Answer builds on ${linked}.`;
    }
    const callout = `[[Callout widget]]\n${sentence}\n[[/Callout widget]]`;
    const placement = String(parsed?.placement || 'start').trim();
    let out = body;
    const insertBeforeLine = (idx: number) => { lines.splice(idx, 0, callout, ''); out = lines.join('\n'); };
    const headingIdx = lines.findIndex((l, i) => kinds[i] === 'heading' && normWords(l.replace(/^#+\s*/, '')) === normWords(placement));
    if (placement === 'end') {
      const quizToken = lines.findIndex((l) => /^\s*EDPWIDGET\d+TOKEN\s*$/.test(l));
      insertBeforeLine(quizToken >= 0 ? quizToken : lines.length);
    } else if (headingIdx >= 0) {
      insertBeforeLine(headingIdx);
    } else {
      // "start": before the first "##" section (after the direct answer, hook, and key takeaways).
      const first = lines.findIndex((l, i) => kinds[i] === 'heading');
      insertBeforeLine(first >= 0 ? first : lines.length);
    }
    draft = restoreWidgets(out.replace(/\n{3,}/g, '\n\n'), blocks);
    const result = { urls: live.map((c) => c.url), sentence, placement, userSentence: !!userSentence };
    stageLog('related-answers', prompt, { urls }, result);
    emit({ type: 'data', name: 'related-answers', payload: result });
    return result;
  });

  // 7d) FAQ links — each FAQ answer may link one other Educative Answer that explains words it already
  // has. Candidates come from research's verified links and Educative's own Answers search; every pick is
  // checked (live page, anchor in the answer, anchor about the page's title). Questions are never touched.
  const faqLinkReport = await stage('faq-links', async () => {
    const faqMatch = draft.match(/\[\[FAQ widget\]\]([\s\S]*?)\[\[\/FAQ widget\]\]/);
    if (!faqMatch) return { skipped: 'no FAQ' };
    const pairs = faqMatch[1].split(/\n(?=\s*Q:)/).map((p) => p.trim()).filter((p) => /^Q:/.test(p))
      .map((p) => {
        const q = p.match(/^Q:\s*(.*)$/m)?.[1]?.trim() || '';
        const a = (p.split(/\n\s*A:\s*/)[1] || '').trim();
        return { raw: p, q, a };
      });
    if (!pairs.length) return { skipped: 'no FAQ pairs' };

    // Pages never linked: this Answer itself (and the live Answer it replaces).
    const exclude = new Set<string>();
    const replaceTarget = parseAnswerId(input.existingAnswerUrl);
    if (replaceTarget && isEducativeConfigured()) {
      try { const ex = await getAnswer(replaceTarget); if (ex.url) exclude.add(normalizeUrl(`https://www.educative.io/answers/${ex.url}`)); } catch {}
    }
    const ownTitle = normWords(title);

    // Candidates: verified internal Answers from research, plus Educative's search for each FAQ's terms.
    const termsPrompt = edpressoFaqSearchTermsPrompt({ title, faqs: pairs.map((p, i) => `${i + 1}. Q: ${p.q}\n   A: ${p.a}`).join('\n') });
    let terms: any[] = [];
    try { terms = (parseJsonLoose(await openaiJSON(termsPrompt, OPENAI_LIGHT)) as any)?.terms || []; } catch (e: any) { if (getAbortSignal()?.aborted) throw e; }
    const queries = [...new Set(terms.flatMap((t: any) => (Array.isArray(t?.queries) ? t.queries : [])).map((q: any) => String(q).trim()).filter(Boolean))].slice(0, 16);
    const found = (await Promise.all(queries.map((q) => searchAnswers(q)))).flat();
    const candMap = new Map<string, { title: string; url: string }>();
    for (const l of verifiedLinks) {
      if (l.kind === 'internal' && /\/answers\//.test(l.url)) candMap.set(normalizeUrl(l.url), { title: l.title || courseTopic(l.url), url: stripTracking(l.url) });
    }
    for (const f of found) if (!candMap.has(normalizeUrl(f.url))) candMap.set(normalizeUrl(f.url), f);
    const bodyLinked = new Set([...protectWidgets(draft).body.matchAll(MD_LINK_RE)].filter((m) => !m[1]).map((m) => normalizeUrl(stripTracking(m[3]))));
    const candidates = [...candMap.values()]
      .filter((c) => !exclude.has(normalizeUrl(c.url)) && normWords(c.title) !== ownTitle)
      .slice(0, 25);
    if (!candidates.length) return { skipped: 'no candidate Answers', queries };

    const linkPrompt = edpressoFaqLinkPrompt({
      title,
      faqs: pairs.map((p, i) => `${i + 1}. ${p.a}`).join('\n'),
      candidates: candidates.map((c, i) => `${i + 1}. ${c.title} — ${c.url}${bodyLinked.has(normalizeUrl(c.url)) ? '' : ' (not linked in the body yet)'}`).join('\n'),
    });
    let picks: any[] = [];
    try { picks = (parseJsonLoose(await openaiJSON(linkPrompt)) as any)?.links || []; } catch (e: any) { if (getAbortSignal()?.aborted) throw e; }

    const usedCands = new Set<number>();
    const linkedFaqs = new Set<number>();
    const applied: any[] = [];
    const rejected: any[] = [];
    let block = faqMatch[1];
    for (const pick of picks) {
      const fi = Number(pick?.faq) - 1, ci = Number(pick?.candidate) - 1;
      const anchor = String(pick?.anchor || '').trim();
      const pair = pairs[fi], cand = candidates[ci];
      const why = !pair || !cand ? 'unknown faq or candidate'
        : linkedFaqs.has(fi) ? 'answer already has a link'
        : usedCands.has(ci) ? 'candidate already used'
        : !anchor || anchor.split(/\s+/).length > 5 || GENERIC_ANCHOR_RE.test(anchor) || /[`*\[\]]/.test(anchor) ? 'bad anchor'
        : !relatesToCourse(anchor, cand.title) ? 'anchor not about the linked Answer'
        : '';
      if (why) { rejected.push({ ...pick, why }); continue; }
      // The anchor must be in the answer, outside inline code and existing links.
      const at = (() => {
        let from = 0;
        for (;;) {
          const i = pair.a.indexOf(anchor, from);
          if (i < 0) return -1;
          const before = pair.a.slice(0, i);
          const inLink = (before.match(/\[/g) || []).length > (before.match(/\]/g) || []).length;
          if (!insideInlineCode(pair.a, i) && !inLink) return i;
          from = i + anchor.length;
        }
      })();
      if (at < 0) { rejected.push({ ...pick, why: 'anchor not found in the answer' }); continue; }
      if (!(await checkUrl(cand.url)).ok) { rejected.push({ ...pick, why: 'page does not load' }); continue; }
      const newA = `${pair.a.slice(0, at)}[${anchor}](${cand.url})${pair.a.slice(at + anchor.length)}`;
      const newRaw = pair.raw.replace(pair.a, () => newA);
      block = block.replace(pair.raw, () => newRaw);
      pair.raw = newRaw; pair.a = newA;
      usedCands.add(ci); linkedFaqs.add(fi);
      applied.push({ faq: pair.q, anchor, url: cand.url, title: cand.title });
    }
    draft = draft.replace(faqMatch[0], () => `[[FAQ widget]]${block}[[/FAQ widget]]`);
    const result = { queries, candidates: candidates.length, applied, rejected };
    stageLog('faq-links', linkPrompt, { queries, candidates: candidates.map((c) => c.url) }, result);
    emit({ type: 'data', name: 'faq-links', payload: result });
    return result;
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
      // Image sync: an image that shows a program's result must agree with what the program really printed.
      const finalRuns: any[] = (codeCheck as any)?.final || [];
      const imageMatches = [...draft.matchAll(IMAGE_TAG_RE)];
      const slideWidget = draft.match(SLIDES_WIDGET_RE.source ? new RegExp(SLIDES_WIDGET_RE.source) : /$^/);
      const slideItems = slideWidget ? parseSlides(slideWidget[1]) : [];
      if (finalRuns.some((r) => r.ran) && (imageMatches.length || slideItems.length)) {
        const programs = finalRuns.map((r) => `Program ${r.program}: ${r.caption}\nOutput:\n${String(r.stdout || '').slice(0, 1200)}`).join('\n\n');
        const images = imageMatches.map((m, k) => {
          const { description, caption } = parseImageTag(m[1]);
          const around = draft.slice(Math.max(0, m.index! - 600), m.index!).split('\n').filter((l) => !/^\s*\[/.test(l)).join('\n').slice(-500);
          return `${k + 1}. Text before it: ${around.replace(/\s+/g, ' ')}\n   Description: ${description}\n   Caption: ${caption}`;
        }).concat(slideItems.map((sl, j) => `${imageMatches.length + j + 1}. (Slide ${j + 1} of ${slideItems.length} in one slideshow; all slides must show the same data) Description: ${sl.text}\n   Caption: (none; return the same text as the description)`))
          .join('\n\n');
        const syncPrompt = edpressoImageSyncPrompt({ title, programs, images });
        let fixes: any[] = [];
        try {
          const parsed: any = parseJsonLoose(await openaiJSON(syncPrompt));
          fixes = Array.isArray(parsed?.images) ? parsed.images : [];
        } catch (e: any) { if (getAbortSignal()?.aborted) throw e; }
        let k = 0;
        draft = draft.replace(IMAGE_TAG_RE, (m) => {
          const fix = fixes.find((f) => Number(f?.n) === ++k);
          const description = String(fix?.description || '').trim();
          if (!description) return m;
          const caption = String(fix?.caption || '').trim() || parseImageTag(m.slice(7, -8)).caption;
          return `[image][Description]${description}[/Description][Caption]${caption}[/Caption][/image]`;
        });
        // Slide lines are fixed in place, keeping the "Slide N:" form (images are generated from them later).
        if (slideWidget && slideItems.length) {
          const fixedSlides = slideItems.map((sl, j) => {
            const fix = fixes.find((f) => Number(f?.n) === imageMatches.length + j + 1);
            const text = String(fix?.description || '').replace(/\s+/g, ' ').trim();
            return text || sl.text;
          });
          const bodySlides = fixedSlides.map((t, j) => `Slide ${j + 1}: ${t}${slideItems[j].url ? ` [Url]${slideItems[j].url}[/Url]` : ''}`).join('\n');
          draft = draft.replace(slideWidget[0], () => `[[Slides widget]]\n${bodySlides}\n[[/Slides widget]]`);
        }
        stageLog('image-sync', syncPrompt, { images: imageMatches.length, slides: slideItems.length }, { fixes });
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
      // Slides: one image per "Slide N:" line, each prompt carrying the whole walkthrough so every slide
      // keeps the same layout, colors, and labels and only the step's change differs.
      const slideReport: any[] = [];
      let slideOrder = imageTags.length;
      const widgets = [...draft.matchAll(SLIDES_WIDGET_RE)];
      for (const w of widgets) {
        const slides = parseSlides(w[1]);
        if (!slides.length) continue;
        const walkthrough = slides.map((sl, k) => `${k + 1}. ${sl.text}`).join(' ');
        const slideUrls = await Promise.all(slides.map(async (sl, k) => {
          if (sl.url) return sl.url;
          const order = ++slideOrder;
          const description = `Slide ${k + 1} of ${slides.length} in one step-by-step walkthrough. All slides share the same layout, colors, positions, labels, and data; only what this step changes is different, and it is highlighted. The whole walkthrough: ${walkthrough} THIS SLIDE (step ${k + 1}): ${sl.text} Show a small "Step ${k + 1} of ${slides.length}" label in a corner.`;
          try {
            const r = await generateGptImage(`[Description]${description}[/Description][Caption]${sl.text}[/Caption]`, order, imgSubfolder);
            stageLog(`slide-generate#${order}`, '(gpt-image-2)', { step: k + 1, text: sl.text }, { url: r.url });
            return r.url;
          } catch (e: any) {
            if (getAbortSignal()?.aborted) throw e;
            emit({ type: 'log', name: `slide-generate#${order}`, message: `Slide image failed: ${e?.message}` });
            return '';
          }
        }));
        slideReport.push({ slides: slides.length, generated: slideUrls.filter(Boolean).length });
        const body = slides.map((sl, k) => `Slide ${k + 1}: ${sl.text}${slideUrls[k] ? ` [Url]${slideUrls[k]}[/Url]` : ''}`).join('\n');
        draft = draft.replace(w[0], () => `[[Slides widget]]\n${body}\n[[/Slides widget]]`);
      }
      emit({ type: 'data', name: 'images', payload: { images: urls, slides: slideReport } });
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
    for (let pass = 1; pass <= 3 && countBodyWords(draft) > spec.maxWords; pass++) {
    const { body, blocks } = protectWidgets(draft);
    const prompt = edpressoTrimPrompt({
      title, wordBudget: spec.budget, currentWordCount: String(countBodyWords(body)),
      cut: String(countBodyWords(body) - Math.round(spec.maxWords * 0.95)), primaryKeyword, draft: body,
    });
    const out = restoreCode(cleanDraft(normalizeImageTags(sanitizeText(await generateText(prompt, { maxTokens: 16000 }))).trim()).markdown, body);
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

  draft = dedupeFaqs(dropWidgetHeadings(moveLineExplanations(draft)), authorFaqs);

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
      tags: answerTags,
      programmingTags,
      codeCheck,
      coverage,
      keywordCap,
      competitorUrls,
      ...meta,
      verifiedLinks,
      rejectedLinks,
      removedLinks,
      courseLinks: courseLinkReport,
      relatedAnswers: relatedReport,
      faqLinks: faqLinkReport,
      bodyLinks: bodyLinkReport,
      docCheck,
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
          tags: answerTags,
          programmingTags,
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

// ---- Revamp check: should an existing Answer be revamped? Judged against the same guidelines the
// generator follows (the reviewer's checklist and the structure for the Answer's type). ----

export interface RevampAssessment {
  verdict: 'revamp' | 'minor-fixes' | 'keep';
  summary: string;
  reasons: string[];
  strengths: string[];
  title: string;
  answerType: string;
  stats: Record<string, number | string>;
}

export async function assessExistingAnswer(shotId: string): Promise<RevampAssessment> {
  const existing = await readAnswerForReview(shotId);
  const title = existing.title || 'Untitled Answer';
  // The Answer's type decides the ideal structure and word budget.
  let parsed: any = {};
  try { parsed = parseJsonLoose(await openaiJSON(edpressoClassifyPrompt({ title, keywords: title, requestedLanguage: '' }), OPENAI_LIGHT)); } catch {}
  const type = (parsed.answerType in ANSWER_TYPES ? parsed.answerType : 'concept') as AnswerType;
  // Same type, scope, and budget rules the generator applies.
  const baseSpec = ANSWER_TYPES[type];
  const narrow = parsed.scope === 'narrow' && type !== 'error';
  const spec: AnswerTypeSpec = narrow
    ? {
        ...baseSpec,
        maxWords: Math.min(baseSpec.maxWords, NARROW_MAX_WORDS),
        budget: baseSpec.maxWords > NARROW_MAX_WORDS ? `300–${NARROW_MAX_WORDS} words (a narrow topic; never more than ${NARROW_MAX_WORDS})` : baseSpec.budget,
        structure: `${baseSpec.structure}\n${NARROW_NOTE}`,
      }
    : baseSpec;
  // The reviewer's checklist is the single source of the guidelines (including edits made on /prompts).
  const reviewer = edpressoReviewerPrompt({
    title, answerTypeLabel: spec.label, wordBudget: spec.budget, currentWordCount: String(existing.stats.bodyWords || ''),
    typeStructure: spec.structure, keywords: title, verifiedLinks: '(any relevant Educative Answers and official documentation)',
    primaryKeyword: String(parsed.primaryKeyword || title),
    terminalRule: 'Only for topics done on the command line.',
    closingRule: 'A short closing with a decision rule or next step, never a summary.',
    draft: '',
  });
  const from = reviewer.indexOf('# Checklist');
  const to = reviewer.indexOf('# Draft');
  const guidelines = from >= 0 ? reviewer.slice(from + '# Checklist'.length, to > from ? to : undefined).trim() : reviewer;
  const stats = Object.entries(existing.stats).map(([k, v]) => `${k}: ${v}`).join(', ');
  const prompt = edpressoAssessPrompt({
    title, answerTypeLabel: spec.label, wordBudget: spec.budget, typeStructure: spec.structure,
    guidelines, stats, answer: existing.text.slice(0, 60000),
  });
  let out: any = {};
  try { out = parseJsonLoose(await openaiJSON(prompt)); } catch (e: any) {
    throw new Error(`The revamp check failed: ${e?.message || e}`);
  }
  const verdict = ['revamp', 'minor-fixes', 'keep'].includes(out?.verdict) ? out.verdict : 'revamp';
  const list = (x: any) => (Array.isArray(x) ? x.map((r: any) => String(r).trim()).filter(Boolean).slice(0, 10) : []);
  return {
    verdict, summary: String(out?.summary || '').trim(), reasons: list(out?.reasons), strengths: list(out?.strengths),
    title, answerType: `${spec.label}${narrow ? ' (narrow topic)' : ''}`, stats: existing.stats,
  };
}
