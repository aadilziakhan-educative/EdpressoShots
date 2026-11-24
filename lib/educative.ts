// Educative Answers editor — creates a Shot as an unpublished draft on educative.io so a human
// reviewer can check it and publish it from https://www.educative.io/editor/create-answer.
//
// The saved Markdown (see lib/edpressoAssemble.ts) is converted to editor blocks:
//   prose                 → MarkdownEditor (keeps links and #key# popups as written)
//   [code]                → runnable Code widget (v8.0 schema) for every language Educative can execute
//   [table]               → Table widget (v2.0 schema)
//   [image] with a [Url]  → image uploaded to the Answer, then an Image widget
//   [[FAQ widget]] …      → FAQ Accordion widget (one tile per Q:/A: pair)
//   [[Quiz widget]] …     → Quiz widget (multiple choice, one slide per question)
//   [[Pause and think widget]] → StructuredQuiz widget (open question, answer revealed on click)
//   [[Callout widget]]    → Callout (a <callout> element in a SlateHTML block)
//   [[Terminal widget]]   → the "Try:" commands as a list, then a Terminal widget whose start script runs "Setup:"
//   other [[X widget]] …  → MarkdownEditor carrying the placeholder, for the reviewer to convert
//
// Auth is the `flask-auth` session cookie of an Educative account that can author Answers.

import { promises as fs } from 'fs';
import path from 'path';
import zlib from 'zlib';
import { marked } from 'marked';
import { splitSegments } from './edpressoAssemble';

const EDUCATIVE_BASE = 'https://www.educative.io';
const IMAGES_DIR = path.join(process.cwd(), 'data', 'images');

// Answers editor endpoints, as called by Educative's own editor (/editor/create-answer and
// /answereditor/[shotId]):
//   create  POST /api/edpresso/shot/id                      → '{"shot_id": …}'
//   save    PUT  /api/edpresso/shot/{id}                    body: zlib-deflated JSON, action "all" = save draft
//   image   GET  /api/edpresso/shot/{id}/image/upload/url   → '{"upload_url": …, "image_id": …}',
//           then POST the file to upload_url as multipart field "file-0"
const ENDPOINTS = {
  create: () => `/api/edpresso/shot/id`,
  save: (shotId: string) => `/api/edpresso/shot/${shotId}`,
  imageUploadUrl: (shotId: string) => `/api/edpresso/shot/${shotId}/image/upload/url`,
  imagePath: (shotId: string, imageId: string) => `/api/edpresso/shot/${shotId}/image/${imageId}`,
  editorUrl: (shotId: string) => `${EDUCATIVE_BASE}/answereditor/${shotId}`,
};

// The editor's default for an Answer without a custom Docker container.
const EMPTY_DOCKER = { jobs: [], version: 3, loaded: true, container: { imageName: '', buildStatusUrl: '', buildLogUrl: '', file: {} }, envs: [] };

export function answerEditorUrl(shotId: string): string {
  return ENDPOINTS.editorUrl(shotId);
}

export function isEducativeConfigured(): boolean {
  return !!process.env.EDUCATIVE_FLASK_AUTH?.trim();
}

function authHeaders(): Record<string, string> {
  const flaskAuth = process.env.EDUCATIVE_FLASK_AUTH?.trim();
  if (!flaskAuth) throw new Error('EDUCATIVE_FLASK_AUTH is not set');
  return { Cookie: `flask-auth=${flaskAuth}` };
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}-${Math.random().toString(16).slice(2)}`;
}

// ---------- Blocks ----------

function makeMarkdownBlock(text: string): any | null {
  const trimmed = text.replace(/\n{3,}/g, '\n\n').trim();
  if (!trimmed) return null;
  return {
    type: 'MarkdownEditor',
    mode: 'edit',
    content: {
      version: '2.0',
      text: trimmed,
      mdHtml: marked.parse(trimmed, { async: false, gfm: true }) as string,
      cursorPosition: { line: 0, ch: 0 },
      comp_id: uid('md'),
    },
    hash: 0,
    iteration: 0,
  };
}

const LANG_MAP: Record<string, string> = {
  js: 'javascript', node: 'javascript', nodejs: 'javascript', ts: 'typescript', py: 'python', python3: 'python',
  cpp: 'c++', csharp: 'c#', cs: 'c#', golang: 'go', sh: 'bash', shell: 'bash', zsh: 'bash', rs: 'rust',
  kt: 'kotlin', mysql: 'sql', postgres: 'postgresql', psql: 'postgresql', txt: 'text', plaintext: 'text',
};
const DEFAULT_ENTRY: Record<string, string> = {
  python: 'main.py', 'c++': 'main.cpp', c: 'main.c', javascript: 'index.js', typescript: 'index.ts',
  java: 'Main.java', go: 'main.go', ruby: 'main.rb', php: 'index.php', rust: 'main.rs',
  kotlin: 'main.kt', sql: 'query.sql', postgresql: 'query.sql', bash: 'script.sh', 'c#': 'Program.cs',
  r: 'main.r', swift: 'main.swift', scala: 'main.scala', perl: 'main.pl', dart: 'main.dart',
};
// Educative's runnable language ids (from the Answers editor's language list), pinned to current
// runtimes. Languages missing here (HTML, CSS, YAML, JSON, plain text…) are shown but not run.
const RUN_LANGUAGE: Record<string, string> = {
  python: 'python310', java: 'java-21', 'c++': 'c++17', c: 'c', 'c#': 'c#12', go: 'go-1242',
  javascript: 'javascript-es2024', typescript: 'typescript-5-8-3', ruby: 'ruby-3-1-2', php: 'php',
  rust: 'rust-1-57-0', kotlin: 'kotlin', swift: 'swift', scala: 'scala', r: 'r', perl: 'perl',
  dart: 'dart', haskell: 'haskell', elixir: 'elixir', bash: 'shell', sql: 'sql-8', postgresql: 'postgresql',
};

function titleCaseLang(l: string): string {
  const special: Record<string, string> = { 'c++': 'C++', 'c#': 'C#', javascript: 'JavaScript', typescript: 'TypeScript', php: 'PHP', sql: 'SQL' };
  return special[l] || (l ? l.charAt(0).toUpperCase() + l.slice(1) : 'Code');
}

// A shell script that cannot run as written: placeholders (<sha>), commands that open an editor or wait
// for input, or Git commands without a repository the script creates itself.
function isUnrunnableShell(code: string): boolean {
  return /<[a-z][\w-]*>/i.test(code)
    || /\b(git\s+rebase\s+(-i|--interactive)\b|vim?\b|nano\b|less\b|read\s)/.test(code)
    || (/^\s*git\s/m.test(code) && !/\bgit\s+(init|clone)\b/.test(code));
}

// Runnable when Educative can execute the language and the code can run as written: readers edit and
// run it (running needs an Educative login, which also drives sign-ups).
function makeCodeBlock(seg: { language: string; caption: string; code: string }): any {
  const base = LANG_MAP[seg.language] || seg.language || 'text';
  const runLanguage = base === 'bash' && isUnrunnableShell(seg.code) ? undefined : RUN_LANGUAGE[base];
  const language = runLanguage || base;
  const entry = DEFAULT_ENTRY[base] || 'main.txt';
  return {
    type: 'Code',
    mode: 'edit',
    content: {
      version: '8.0',
      caption: seg.caption,
      language,
      title: '',
      theme: 'default',
      additionalContent: [],
      selectedIndex: 0,
      runnable: !!runLanguage,
      judge: false,
      staticEntryFileName: true,
      judgeContent: null,
      judgeHints: null,
      allowDownload: false,
      treatOutputAsHTML: false,
      enableHiddenCode: false,
      enableStdin: false,
      evaluateWithoutExecution: false,
      showSolution: false,
      widgetTitle: titleCaseLang(base),
      timeLimit: 30,
      stdoutLimit: 3072,
      hiddenCodeContent: { prependCode: '\n\n', appendCode: '\n\n', codeSelection: 'prependCode' },
      dockerJob: {},
      selectedApiKeys: {},
      selectedEnvVars: {},
      specialInput: 'no-input',
      solutionContent: '\n\n\n',
      judgeContentPrepend: '\n\n\n',
      evaluateLanguage: language,
      isCodeDrawing: false,
      content: seg.code,
      comp_id: uid('code'),
      entryFileName: entry,
      staticEntryName: false,
      defaultSelectedFile: entry,
    },
    iteration: 1,
    hash: 1,
    children: [{ text: '' }],
    status: 'normal',
    contentID: uid('code'),
    saveVersion: 1,
  };
}

function inlineMdToHtml(s: string): string {
  return (marked.parseInline(String(s ?? '').trim(), { async: false, gfm: true }) as string);
}

function makeTableBlock(seg: { title: string; table: string }): any | null {
  const isSep = (row: string[]) => row.every((c) => /^:?-+:?$/.test(c));
  const rows = seg.table.split('\n')
    .map((l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()))
    .filter((r) => r.length && !isSep(r));
  if (!rows.length) return null;
  const cols = rows[0].length;
  const data = rows.map((r) => Array.from({ length: cols }, (_, i) => `<p>${inlineMdToHtml(r[i] || '')}</p>`));
  return {
    type: 'Table',
    mode: 'edit',
    content: {
      version: '2.0',
      comp_id: uid('table'),
      numberOfRows: data.length,
      numberOfColumns: cols,
      columnWidths: Array(cols).fill(250),
      data,
      mergeInfo: {},
      customStyles: data.map((r) => r.map(() => ({}))),
      template: 1,
      title: seg.title,
      titleAlignment: 'align-center',
    },
    iteration: 1,
    hash: 1,
    children: [{ text: '' }],
    status: 'normal',
    contentID: uid('table'),
    saveVersion: 1,
  };
}

// FAQ placeholder body: "Q: …" then "A: …", where an answer may continue over several lines
// (including a fenced code snippet) until the next "Q:".
function parseFaqs(body: string): { question: string; answer: string }[] {
  const faqs: { question: string; answer: string }[] = [];
  let current: { question: string; answer: string } | null = null;
  let inAnswer = false;
  for (const line of body.split('\n')) {
    const q = line.match(/^\s*Q:\s*(.*)$/);
    const a = line.match(/^\s*A:\s*(.*)$/);
    if (q) {
      current = { question: q[1].trim(), answer: '' };
      faqs.push(current);
      inAnswer = false;
    } else if (current && a && !inAnswer) {
      current.answer = a[1];
      inAnswer = true;
    } else if (current) {
      if (inAnswer) current.answer += `\n${line}`;
      else if (line.trim()) current.question += ` ${line.trim()}`;
    }
  }
  return faqs
    .map((f) => ({ question: f.question.trim(), answer: f.answer.trim() }))
    .filter((f) => f.question && f.answer);
}

// FAQ Accordion widget: a title plus question/answer tiles; answers are Markdown.
function makeFaqBlock(faqs: { question: string; answer: string }[]): any {
  return {
    type: 'FaqAccordion',
    mode: 'edit',
    content: {
      version: '1',
      title: 'Frequently asked questions',
      faqs: faqs.map((f, i) => ({ id: String(i + 1), ...f })),
      comp_id: uid('faq'),
    },
    iteration: 1,
    hash: 0,
    children: [{ text: '' }],
    status: 'normal',
    contentID: uid('faq'),
    saveVersion: 1,
  };
}

const md = (text: string) => marked.parse(text, { async: false, gfm: true }) as string;

// Callout: a rich-text (SlateHTML) block holding a <callout> element, the way the editor serializes
// its Callout. Each non-empty line of the placeholder becomes a paragraph (quote, then attribution).
function makeCalloutBlock(body: string): any | null {
  const paras = body.split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => `<p>${marked.parseInline(l, { async: false, gfm: true }) as string}</p>`);
  if (!paras.length) return null;
  return {
    type: 'SlateHTML',
    content: { html: `<callout data-message-type=Message data-emoji=undefined>${paras.join('')}</callout>`, comp_id: uid('callout') },
    hash: 0,
  };
}

// Terminal placeholder body: "Setup:" commands (run automatically when the terminal opens) and "Try:"
// commands (for the reader to type). A body without labels is treated as commands to try.
function parseTerminal(body: string): { setup: string[]; tryCommands: string[] } {
  const setup: string[] = [];
  const tryCommands: string[] = [];
  let target = tryCommands;
  for (const raw of body.replace(/^\s*```[\w-]*\s*$/gm, '').split('\n')) {
    if (/^\s*Setup:\s*$/i.test(raw)) { target = setup; continue; }
    if (/^\s*Try:\s*$/i.test(raw)) { target = tryCommands; continue; }
    const line = raw.replace(/^\s*\$\s?/, '').trimEnd();
    if (line.trim()) target.push(line);
  }
  return { setup, tryCommands };
}

// Terminal widget in the Answer's default container. The setup commands become its startScript (run
// when it opens, as on published Answers such as "How to perform a POST request using cURL"); the
// commands to try are listed just above it.
function makeTerminalBlocks(body: string): any[] {
  const { setup, tryCommands } = parseTerminal(body);
  if (!setup.length && !tryCommands.length) return [];
  const blocks: any[] = [];
  if (tryCommands.length) {
    blocks.push(makeMarkdownBlock(`Type these commands in the terminal below, one at a time:\n\n${tryCommands.map((c, i) => `${i + 1}. \`${c}\``).join('\n')}`));
  }
  blocks.push({
    type: 'TerminalWidget',
    mode: 'edit',
    content: { version: 1, comp_id: uid('terminal'), ...(setup.length ? { startScript: setup.join('\n') } : {}) },
    iteration: 0,
    hash: 0,
    children: [{ text: '' }],
    status: 'normal',
    contentID: uid('terminal'),
    saveVersion: 1,
  });
  return blocks;
}

// Quiz placeholder body, as the writer emits it:
//   Q1. <question>  /  A) … D) <option>  /  Correct answer: <letter>  /  Explanation: <sentence>
function parseQuiz(body: string): { question: string; options: string[]; correct: number; explanation: string }[] {
  const out: { question: string; options: string[]; correct: number; explanation: string }[] = [];
  let cur: { question: string; options: string[]; correct: number; explanation: string } | null = null;
  for (const line of body.split('\n')) {
    const q = line.match(/^\s*Q\d+[.)]\s*(.*)$/);
    const opt = line.match(/^\s*([A-H])[).]\s+(.*)$/);
    const ans = line.match(/^\s*Correct answer:\s*\(?([A-H])\)?/i);
    const exp = line.match(/^\s*Explanation:\s*(.*)$/i);
    if (q) { cur = { question: q[1].trim(), options: [], correct: -1, explanation: '' }; out.push(cur); }
    else if (!cur) continue;
    else if (ans) cur.correct = ans[1].toUpperCase().charCodeAt(0) - 65;
    else if (exp) cur.explanation = exp[1].trim();
    else if (opt && !cur.explanation) cur.options.push(opt[2].trim());
    else if (cur.explanation && line.trim()) cur.explanation += ` ${line.trim()}`;
    else if (!cur.options.length && line.trim()) cur.question += `\n${line}`;
  }
  return out.filter((x) => x.question && x.options.length >= 2 && x.correct >= 0 && x.correct < x.options.length);
}

// Same shape as the Quiz widgets on published Answers. The explanation goes on the correct option.
function makeQuizBlock(questions: ReturnType<typeof parseQuiz>): any {
  return {
    type: 'Quiz',
    mode: 'edit',
    content: {
      version: '1.0',
      title: 'Quiz',
      renderMode: 'slide',
      dynamicQuestionsCount: null,
      questions: questions.map((q, qi) => ({
        id: uid(`q${qi}`),
        questionText: q.question,
        questionTextHtml: md(q.question),
        questionOptions: q.options.map((text, oi) => {
          const explanation = oi === q.correct ? q.explanation : '';
          return {
            text,
            id: uid(`q${qi}o${oi}`),
            correct: oi === q.correct,
            explanation: { mdText: explanation, mdHtml: explanation ? md(explanation) : '' },
            mdHtml: md(text),
          };
        }),
      })),
      comp_id: uid('quiz'),
    },
    iteration: 1,
    hash: 0,
    children: [{ text: '' }],
    status: 'normal',
    contentID: uid('quiz'),
    saveVersion: 1,
  };
}

// "Pause and think": an open question whose answer the reader reveals, as on published Answers.
function makeStructuredQuizBlock(items: { question: string; answer: string }[]): any {
  return {
    type: 'StructuredQuiz',
    mode: 'edit',
    content: {
      version: '1.0',
      title: '',
      renderMode: 'continuous',
      questions: items.map((q) => ({
        questionText: q.question,
        questionTextHtml: md(q.question),
        answerText: q.answer,
        answerTextHtml: md(q.answer),
      })),
      titleMdHtml: '',
      comp_id: uid('think'),
    },
    iteration: 0,
    hash: 0,
    children: [{ text: '' }],
    status: 'normal',
    contentID: uid('think'),
    saveVersion: 1,
  };
}

// The Answers editor renders an image from its image_id (/api/edpresso/shot/{shotId}/image/{image_id}).
function makeImageBlock(imageId: string, imagePath: string, caption: string, sizeInBytes: number): any {
  return {
    type: 'Image',
    mode: 'edit',
    content: {
      image_id: imageId,
      path: imagePath,
      metadata: { width: 1280, height: 720, sizeInBytes, name: 'image.png' },
      caption,
      borderColor: '#000000',
      version: 3,
      alignment: 'center',
      redirectionUrl: '',
      comp_id: uid('img'),
      width: 668,
      imageType: 'data:image/png',
    },
    iteration: 1,
    hash: 0,
    children: [{ text: '' }],
    status: 'normal',
    contentID: uid('img'),
    saveVersion: 1,
  };
}

// ---------- HTTP ----------

async function educativeFetch(pathname: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${EDUCATIVE_BASE}${pathname}`, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers as Record<string, string> || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Educative ${init.method || 'GET'} ${pathname} failed (${res.status}): ${text.slice(0, 300)}`);
  // The editor JSON.parses these responses itself, so some arrive as a JSON-encoded string.
  let data: any = text;
  for (let i = 0; i < 2 && typeof data === 'string'; i++) {
    try { data = JSON.parse(data); } catch { break; }
  }
  return data;
}

async function createShot(): Promise<string> {
  const json = await educativeFetch(ENDPOINTS.create(), { method: 'POST' });
  const shotId = json?.shot_id;
  if (!shotId) throw new Error(`Educative create Answer returned no shot id: ${JSON.stringify(json).slice(0, 300)}`);
  return String(shotId);
}

// Reads a locally generated image (/api/images/…) and uploads it to the Answer. Returns the
// Educative image id, or null when the image is missing or the upload fails.
async function uploadImage(shotId: string, localUrl: string): Promise<{ imageId: string; path: string; size: number } | null> {
  const segments = localUrl.replace(/^\/api\/images\//, '').split('/');
  if (!localUrl.startsWith('/api/images/') || segments.some((s) => !s || s === '..')) return null;
  let buffer: Buffer;
  try { buffer = await fs.readFile(path.join(IMAGES_DIR, ...segments)); } catch { return null; }
  try {
    const slot = await educativeFetch(ENDPOINTS.imageUploadUrl(shotId));
    const uploadUrl = slot?.upload_url;
    const imageId = slot?.image_id;
    if (!uploadUrl || !imageId) return null;
    const form = new FormData();
    form.append('file-0', new Blob([buffer as unknown as ArrayBuffer], { type: 'image/png' }), segments[segments.length - 1]);
    await educativeFetch(uploadUrl.replace(EDUCATIVE_BASE, ''), { method: 'POST', body: form });
    return { imageId: String(imageId), path: ENDPOINTS.imagePath(shotId, String(imageId)), size: buffer.length };
  } catch {
    return null;
  }
}

export async function buildAnswerBlocks(markdown: string, shotId: string): Promise<{ blocks: any[]; imageIds: string[]; imageFailures: number }> {
  const { prose, segments } = splitSegments(markdown);
  const blocks: any[] = [];
  const imageIds: string[] = [];
  let imageFailures = 0;
  const parts = prose.split(/EDPSEG(\d+)TOKEN/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      const md = makeMarkdownBlock(parts[i]);
      if (md) blocks.push(md);
      continue;
    }
    const seg = segments[Number(parts[i])];
    if (seg.kind === 'code') {
      blocks.push(makeCodeBlock(seg));
    } else if (seg.kind === 'table') {
      const table = makeTableBlock(seg);
      blocks.push(table || makeMarkdownBlock(`${seg.title}\n\n${seg.table}`));
    } else if (seg.kind === 'image') {
      const uploaded = seg.url ? await uploadImage(shotId, seg.url) : null;
      if (uploaded) {
        imageIds.push(uploaded.imageId);
        blocks.push(makeImageBlock(uploaded.imageId, uploaded.path, seg.caption, uploaded.size));
      } else {
        imageFailures++;
        blocks.push(makeMarkdownBlock(`**[[Image widget — not uploaded]]**\n\nDescription: ${seg.description}${seg.caption ? `\n\nCaption: ${seg.caption}` : ''}`));
      }
    } else if (seg.widget === 'FAQ' && parseFaqs(seg.body).length) {
      blocks.push(makeFaqBlock(parseFaqs(seg.body)));
    } else if (seg.widget === 'Quiz' && parseQuiz(seg.body).length) {
      blocks.push(makeQuizBlock(parseQuiz(seg.body)));
    } else if (seg.widget === 'Pause and think' && parseFaqs(seg.body).length) {
      blocks.push(makeStructuredQuizBlock(parseFaqs(seg.body)));
    } else if (seg.widget === 'Callout' && makeCalloutBlock(seg.body)) {
      blocks.push(makeCalloutBlock(seg.body));
    } else if (seg.widget === 'Terminal' && makeTerminalBlocks(seg.body).length) {
      blocks.push(...makeTerminalBlocks(seg.body));
    } else {
      // Keep the placeholder's line structure ("Q1.", "A)", "Slide 1:" …): one paragraph per line
      // outside code fences, so Markdown does not merge consecutive lines.
      let inFence = false;
      const body = seg.body.split('\n').map((l) => {
        if (/^\s*```/.test(l)) inFence = !inFence;
        return inFence || /^\s*```/.test(l) || !l.trim() ? l : `${l}\n`;
      }).join('\n');
      blocks.push(makeMarkdownBlock(`**[[${seg.widget} widget]]**\n\n${body}\n\n**[[/${seg.widget} widget]]**`));
    }
  }
  return { blocks: blocks.filter(Boolean), imageIds, imageFailures };
}

export interface EducativeDraft {
  shotId: string;
  editorUrl: string;
  pushedAt: string;
  imageFailures: number;
  replacedExisting?: boolean;
}

// Answer ID from an editor link, or a bare ID. Accepts
//   https://www.educative.io/editor/answereditor/6241014612361216
//   https://www.educative.io/answereditor/6241014612361216
// Returns null for anything else (published /answers/<slug> pages carry no ID).
export function parseAnswerId(link: string | undefined | null): string | null {
  const s = (link || '').trim();
  if (!s) return null;
  if (/^\d{6,}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (!/(^|\.)educative\.io$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/\/answereditor\/(\d{6,})\/?$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export interface ExistingAnswer {
  shotId: string;
  title: string;
  tags: string;
  url: string;
  canonical_url: string;
  programming_tags: string;
  topic_tags: string;
  docker: any;
}

// Loads an Answer's settings (same call the editor makes on open). Throws when the account in
// EDUCATIVE_FLASK_AUTH cannot open it.
export async function getAnswer(shotId: string): Promise<ExistingAnswer> {
  let shot: any;
  try {
    shot = await educativeFetch(ENDPOINTS.save(shotId), { method: 'GET' });
  } catch (e: any) {
    throw new Error(`Could not open Answer ${shotId} on Educative. Check the link and that the EDUCATIVE_FLASK_AUTH account can edit it. (${e?.message || e})`);
  }
  if (!shot || typeof shot !== 'object') throw new Error(`Answer ${shotId} was not found on Educative`);
  return {
    shotId,
    title: shot.title || '',
    tags: shot.tags || '',
    url: shot.url || '',
    canonical_url: shot.canonical_url || '',
    programming_tags: shot.programming_tags || '',
    topic_tags: shot.topic_tags || '',
    docker: shot.docker && typeof shot.docker === 'object' ? shot.docker : EMPTY_DOCKER,
  };
}

// Creates the Answer on Educative (or overwrites the same draft when shotId is given) and saves its
// content. It is never published here; a reviewer publishes it from the Educative editor.
// With replaceExisting, shotId is an Answer that existed before this tool: its whole content, title
// and tags are replaced, while its published URL, canonical URL, topic and programming tags, and
// Docker setup are kept so the live link doesn't change when the reviewer republishes.
export async function pushAnswerDraft(args: {
  title: string;
  markdown: string;
  tags?: string[];
  slug?: string;
  shotId?: string;
  replaceExisting?: boolean;
}): Promise<EducativeDraft> {
  if (args.replaceExisting && !args.shotId) throw new Error('replaceExisting needs the existing Answer ID');
  const existing = args.replaceExisting ? await getAnswer(args.shotId!) : null;
  const shotId = args.shotId || await createShot();
  const { blocks, imageIds, imageFailures } = await buildAnswerBlocks(args.markdown, shotId);
  // Same body the editor's Save button sends. For a new Answer url stays empty: the editor only
  // sets it on publish.
  const shot = {
    title: args.title,
    tags: (args.tags || []).join(',') || existing?.tags || '',
    programming_tags: existing?.programming_tags || '',
    topic_tags: existing?.topic_tags || '',
    url: existing?.url || '',
    docker: existing?.docker || EMPTY_DOCKER,
    canonical_url: existing?.canonical_url || '',
  };
  const body = {
    ...shot,
    content: JSON.stringify({ shotId, ...shot, content: blocks }),
    action: 'all',
    image_ids: JSON.stringify(imageIds),
  };
  await educativeFetch(ENDPOINTS.save(shotId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'deflate', 'X-ETag': 'overwrite' },
    body: zlib.deflateSync(JSON.stringify(body), { level: 9 }),
  });
  return {
    shotId,
    editorUrl: ENDPOINTS.editorUrl(shotId),
    pushedAt: new Date().toISOString(),
    imageFailures,
    ...(args.replaceExisting ? { replacedExisting: true } : {}),
  };
}
