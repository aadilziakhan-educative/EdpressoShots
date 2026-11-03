// Edpresso Shots (Educative Answers) pipeline.
//
//   classify ─► competitor-research ‖ link-discovery ─► link-verify ─► outline ─► writer
//     ─► reviewer (body only; re-runs once if still over the word budget; then Quiz/FAQ fact-check) ─► link-guard
//     ─► seo-meta ‖ images ─► assemble
//
// The writer produces code and tables itself (inside [code]/[table] tags)
// so line-by-line explanations always match the code. Only images are generated separately.
// Widgets Educative has but we cannot produce (quiz, FAQ, callout, slides, LaTeX) are emitted as
// [[X widget]] … [[/X widget]] placeholders carrying their full content. The output is copy-pasted
// into the Educative Answers editor — there is no publish step.

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
} from './edpressoPromptsRegistry';
import { sanitizeText } from './transforms';
import { generateGptImage, slugify } from './imageGen';
import { getAbortSignal } from './abortContext';
import { edpressoToHtml, countBodyWords, countSegments, parseImageTag } from './edpressoAssemble';

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
}

interface AnswerTypeSpec {
  label: string;
  maxWords: number;
  budget: string;
  structure: string;
}

export const ANSWER_TYPES: Record<AnswerType, AnswerTypeSpec> = {
  error: {
    label: 'Error or troubleshooting',
    maxWords: 250,
    budget: 'under 250 words',
    structure: `Target: under 250 body words. Get straight to the cause and the fix; no padding.
Order:
1. Key takeaways blockquote with 2–3 bullets.
2. "## What causes the <error>?" — a 40–60 word definition of what the error means and when it appears.
3. The situations that trigger it, as a short bulleted list (most common first). Add one image only if a diagram of the situation clearly helps.
4. "## How to fix the <error>" — the fix as numbered steps with the exact command(s). Mention any risk of the fix (for example, data loss) and a safer alternative when one exists.
5. Cite the official documentation for the command or setting when it is in the verified links.
6. A 1–2 sentence closing section.
7. FAQ widget.
Omit: callout quote, history, quiz, slides, and tables (unless the fix differs by version or platform).`,
  },
  function: {
    label: 'Function or API reference',
    maxWords: 500,
    budget: 'under 500 words',
    structure: `Target: under 500 body words.
Order:
1. Optional Callout widget, only if a real, relevant quote or fun fact exists.
2. Key takeaways blockquote with 3–4 bullets.
3. "## What is <function>?" — a 40–60 word definition: what it does, what it returns, where it lives (module, class, or header), and since which version if relevant.
4. One or two sentences of motivation: when a developer needs it, including the operations or scenarios that make it relevant (for example, which operations produce NaN for is_nan()).
5. "### Syntax" — the signature as a short fenced snippet (not a [code] tag, since it is not a full program).
6. "### Parameters" — each parameter with its type and meaning (a table if there are three or more).
7. "### Return value" — the type and what each possible value means.
8. "### Example" — one runnable program in a [code] tag covering the common case and at least one edge case, followed by a line-by-line explanation.
9. Edge cases, version or deprecation notes, and a comparison with related functions (as a table) only if they matter.
10. Closing section, Quiz widget only if three meaningful questions exist, FAQ widget.`,
  },
  howto: {
    label: 'How-to with multiple methods',
    maxWords: 1000,
    budget: '500–1,000 words (never more than 1,000)',
    structure: `Target: 500–1,000 body words; never over 1,000.
Order:
1. Optional Callout widget with a real expert quote or fun fact.
2. Key takeaways blockquote with 4–6 bullets (one per method, plus when to use which).
3. Opening: a motivation hook (why and where this task matters, with real-world applications), the primary keyword, and a short bulleted preview of the methods covered.
4. A "What is…" section with a 40–60 word definition of the underlying concept (for example, what a random number or string concatenation is).
5. One section per method, headed "Method N: <method>" or "N. <Action> using <method>", ordered from the most common or simplest to the most specialized. For each: one or two sentences on what it is and when to use it, numbered steps if setup is needed, a runnable [code] tag with a keyword-rich caption, and a line-by-line explanation of the key lines. Add a Note blockquote for gotchas (thread safety, type conversion, security).
6. A comparison table of all methods (use case, strengths, limitations or performance) with a title, followed by a short "how to choose" paragraph.
7. Closing section with a pointer to a verified course or path, Quiz widget, FAQ widget.`,
  },
  concept: {
    label: 'Concept or algorithm',
    maxWords: 1000,
    budget: 'up to 1,000 words (as short as the concept allows)',
    structure: `Target: as short as the concept allows; at most 1,000 body words.
Order:
1. Optional Callout widget (a real quote or fun fact).
2. Key takeaways blockquote with 4–6 bullets.
3. "## What is <concept>?" — a 40–60 word definition, then history (who introduced it and when) if relevant.
4. Motivation: why it matters and where it is used in the real world (named applications, companies, or fields).
5. The problem it solves, with a concrete example using real values.
6. How it works: a step-by-step walkthrough (dry run) on the concrete example. Use a Slides widget placeholder or up to two images for the walkthrough.
7. Formulas or complexity (Big O) in a LaTeX widget placeholder or inline, with an explanation of where they come from.
8. Code: the bigger picture first, then a runnable [code] tag, then a line-by-line explanation.
9. When the title compares related concepts, give each its own "What is…" subsection and end with a comparison table.
10. Applications and popular libraries or tools that implement it.
11. Closing section, Quiz widget, FAQ widget.`,
  },
  technology: {
    label: 'Technology or framework',
    maxWords: 1000,
    budget: 'up to 1,000 words',
    structure: `Target: at most 1,000 body words.
Order:
1. Optional Callout widget (a quote from the creator or a well-known user, or a fun fact).
2. Key takeaways blockquote with 4–6 bullets.
3. "## What is <technology>?" — a 40–60 word definition first (for the featured snippet), then a short history: creator, year, and how it evolved.
4. Why it matters: the problem it solves, adoption numbers, and well-known companies or products that use it (only facts from the research).
5. Key features in logical order (foundational features first, dependent features after; most important first), each with a one or two sentence explanation.
6. A "Hello World" or minimal example in a runnable [code] tag, with an explanation.
7. Common use cases.
8. Strengths and limitations (a table works well), plus ecosystem, deprecation, or version notes where relevant.
9. Closing section with a pointer to a verified course or path, Quiz widget, FAQ widget.`,
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

// A rewrite is accepted only if it kept the Answer intact: similar length and every code tag.
function isSafeRewrite(before: string, after: string): boolean {
  if (!after || after.length < before.length * 0.5) return false;
  const codeCount = (s: string) => (s.match(/\[code\]/g) || []).length;
  return codeCount(after) >= codeCount(before);
}

// The Quiz and FAQ widgets are not part of the word budget, so the reviewer never sees them: it
// would trim FAQs to save words. They are split off here and re-attached, in order, after review.
const PROTECTED_WIDGET_RE = /\[\[(Quiz|FAQ) widget\]\][\s\S]*?\[\[\/\1 widget\]\]/g;
function splitProtectedWidgets(md: string): { body: string; tail: string } {
  const blocks = md.match(PROTECTED_WIDGET_RE) || [];
  return { body: md.replace(PROTECTED_WIDGET_RE, '').replace(/\n{3,}/g, '\n\n').trim(), tail: blocks.join('\n\n') };
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
  const { verifiedLinks, rejectedLinks } = await stage('link-verify', async () => {
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

    const results = await mapLimit(toCheck, 6, async (c) => ({ c, r: await checkUrl(c.url) }));
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
    const payload = { verified, rejected };
    stageLog('link-verify', '(HTTP GET each candidate, follow redirects, keep 2xx)', { candidates: candidates.length, checked: toCheck.length }, payload);
    emit({ type: 'data', name: 'link-verify', payload });
    return { verifiedLinks: verified, rejectedLinks: rejected };
  });
  const verifiedLinksStr = formatVerifiedLinks(verifiedLinks);
  const allowedUrls = new Set<string>(verifiedLinks.flatMap((l) => [normalizeUrl(l.url), normalizeUrl(l.finalUrl)]));

  // 4) Outline.
  const outline = await stage('outline', async () => {
    const args = {
      title, answerTypeLabel: spec.label, wordBudget: spec.budget, typeStructure: spec.structure,
      language: languageStr, keywords: keywordsStr,
      userFaqs: userFaqs.length ? userFaqs.map((q) => `- ${q}`).join('\n') : '(none provided — take all FAQs from People also ask)',
      research, verifiedLinks: verifiedLinksStr,
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
      research, verifiedLinks: verifiedLinksStr,
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
    const { body, tail } = splitProtectedWidgets(draft);
    let d = body;
    const passes: { pass: number; wordsBefore: number; wordsAfter: number; accepted: boolean }[] = [];
    for (let pass = 1; pass <= 2; pass++) {
      const wordsBefore = countBodyWords(d);
      if (pass === 2 && wordsBefore <= spec.maxWords * 1.1) break;
      const prompt = edpressoReviewerPrompt({
        title, answerTypeLabel: spec.label, wordBudget: spec.budget, currentWordCount: String(wordsBefore),
        typeStructure: spec.structure, keywords: keywordsStr, verifiedLinks: verifiedLinksStr, draft: d,
      });
      const out = normalizeImageTags(sanitizeText(await generateText(prompt, { maxTokens: 16000 }))).trim();
      const accepted = isSafeRewrite(d, out);
      if (accepted) d = out;
      passes.push({ pass, wordsBefore, wordsAfter: countBodyWords(d), accepted });
      stageLog(`reviewer#${pass}`, prompt, { wordsBefore, budget: spec.maxWords }, out);
    }
    // Fact-check the Quiz and FAQ separately; accept only if every question survived unchanged.
    let checkedTail = tail;
    if (tail) {
      const prompt = edpressoWidgetReviewPrompt({ title, language: languageStr, keywords: keywordsStr, verifiedLinks: verifiedLinksStr, widgets: tail });
      const out = normalizeImageTags(sanitizeText(await generateText(prompt, { maxTokens: 8000 }))).trim();
      const sameFaqs = faqQuestions(out).map(normQuestion).join('|') === faqQuestions(tail).map(normQuestion).join('|');
      const sameQuiz = (out.match(/^\s*Q\d+\./gm) || []).length === (tail.match(/^\s*Q\d+\./gm) || []).length;
      const accepted = sameFaqs && sameQuiz && /\[\[\/(FAQ|Quiz) widget\]\]/.test(out);
      if (accepted) checkedTail = out;
      stageLog('widget-review', prompt, { accepted }, out);
    }
    const reviewed = checkedTail ? `${d}\n\n${checkedTail}` : d;
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

  // 8) SEO meta ‖ image generation.
  const imageTags = [...draft.matchAll(/\[image\]([\s\S]*?)\[\/image\]/g)].map((m) => m[1]);
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
    const edpresso = {
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

  emit({ type: 'final', payload: final });
  return final;
}
