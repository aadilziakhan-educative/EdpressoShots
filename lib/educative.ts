// Educative Answers editor — creates a Shot as an unpublished draft on educative.io so a human
// reviewer can check it and publish it from https://www.educative.io/editor/create-answer.
//
// The saved Markdown (see lib/edpressoAssemble.ts) is converted to editor blocks:
//   prose                 → MarkdownEditor (keeps links and #key# popups as written)
//   [code]                → runnable Code widget (v8.0 schema) for every language Educative can execute
//   [table]               → Table widget (v2.0 schema)
//   [image] with a [Url]  → image uploaded to the Answer, then an Image widget
//   [[FAQ widget]] …      → FAQ widget (FAQMarketing: one question/answer pair per Q:/A:)
//   [[Quiz widget]] …     → Quiz widget (multiple choice, one slide per question)
//   [[Pause and think widget]] → StructuredQuiz widget (open question, answer revealed on click)
//   [[Callout widget]]    → Callout (a <callout> element in a SlateHTML block)
//   [[Terminal widget]]   → the "Try:" commands as a list, then a Terminal widget whose start script runs "Setup:"
//   [[LaTeX widget]]      → block Latex widget (KaTeX-rendered; one per formula)
//   [[Slides widget]]     → Slides (CanvasAnimation) widget, one uploaded image per slide; a numbered list if images are missing
//   other [[X widget]] …  → MarkdownEditor carrying the placeholder, for the reviewer to convert
//
// Auth is the `flask-auth` session cookie of an Educative account that can author Answers.

import { promises as fs } from 'fs';
import path from 'path';
import zlib from 'zlib';
import { marked } from 'marked';
import katex from 'katex';
import { splitSegments, parseSlides, normalizeKeywordSyntax, stripKeywordSyntax, countBodyWords } from './edpressoAssemble';

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

// What Educative's Markdown renderer does with "#key# term: meaning #key#": a <keyword> element that
// readers see as the term with its meaning on hover. Applied to our rendered HTML so the saved block
// matches what the editor itself would store.
function keywordHtml(html: string): string {
  return html.replace(/#key# ([^#|^\n:]+?): ([^#|^\n]+?) #key#/g, (_m, word, meaning) =>
    `<keyword><word>${word.trim()}</word><meaning>${meaning.trim()}</meaning></keyword>`);
}

function makeMarkdownBlock(text: string): any | null {
  const trimmed = normalizeKeywordSyntax(text).replace(/\n{3,}/g, '\n\n').trim();
  if (!trimmed) return null;
  return {
    type: 'MarkdownEditor',
    mode: 'edit',
    content: {
      version: '2.0',
      text: trimmed,
      mdHtml: keywordHtml(marked.parse(trimmed, { async: false, gfm: true }) as string),
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

// ---------- Running code ----------

export interface CodeRunResult {
  ran: boolean;          // false when the language can't run on Educative (or the shell script can't run as written)
  ok: boolean;           // exit status 0
  stdout: string;
  stderr: string;
  time: string;
  reason?: string;
}

// Runs a program the way the Code widget's Run button does (POST /api/code/execute), so the output is
// what readers will see. Needs EDUCATIVE_FLASK_AUTH.
export async function runCode(language: string, code: string): Promise<CodeRunResult> {
  const base = LANG_MAP[language] || language;
  const runLanguage = base === 'bash' && isUnrunnableShell(code) ? undefined : RUN_LANGUAGE[base];
  if (!runLanguage) return { ran: false, ok: false, stdout: '', stderr: '', time: '', reason: `${language || 'this language'} is not runnable on Educative` };
  const form = new URLSearchParams({
    language: runLanguage,
    entry_filename: DEFAULT_ENTRY[base] || 'main.txt',
    source_code: code,
    stdin: '',
    comp_type: 'Code',
  });
  const res = await educativeFetch('/api/code/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const cap = (s: any) => String(s || '').slice(0, 4000);
  return {
    ran: true,
    ok: res?.status === 0,
    stdout: cap(res?.stdout),
    stderr: cap(res?.stderr),
    time: String(res?.time || ''),
    reason: String(res?.reason || ''),
  };
}

// The editor's block Latex widget. Its content is what the editor itself builds from an equation:
// { version: "1.0", text: <LaTeX>, mdhtml: <KaTeX-rendered HTML>, isEquationValid, comp_id }. The editor
// shows mdhtml, so the formula is rendered here with KaTeX; an invalid formula is left as a placeholder.
// Blank lines separate formulas; each becomes its own widget.
function makeLatexBlocks(latex: string): any[] {
  const formulas = latex.replace(/^\s*\$\$|\$\$\s*$/g, '').split(/\n\s*\n/).map((f) => f.trim()).filter(Boolean);
  const blocks: any[] = [];
  for (const text of formulas) {
    let mdhtml = '';
    try { mdhtml = katex.renderToString(text, { displayMode: true, throwOnError: true }); } catch { mdhtml = ''; }
    if (!mdhtml) return [];
    blocks.push({
      type: 'Latex',
      mode: 'edit',
      content: { version: '1.0', text, mdhtml, isEquationValid: true, comp_id: uid('latex') },
      hash: 0,
      iteration: 0,
      children: [{ text: '' }],
      status: 'normal',
      contentID: uid('latex'),
      saveVersion: 1,
    });
  }
  return blocks;
}

// Fallback when slide images are missing: the slide lines as a numbered list.
function makeStepsBlock(body: string): any | null {
  const steps = parseSlides(body).map((sl) => sl.text).filter(Boolean);
  if (!steps.length) return null;
  return makeMarkdownBlock(steps.map((s, i) => `${i + 1}. ${s}`).join('\n'));
}

// Educative's Slides widget is "CanvasAnimation": one fabric.js canvas per slide. Each slide here holds
// one image uploaded to the Answer, scaled to fill the canvas, with the SVG copy the viewer renders
// (same shape as slides made in the editor).
const SLIDE_W = 800;
const SLIDE_H = 450;
function makeSlidesBlock(slides: { src: string; width: number; height: number }[]): any {
  const canvasObjects = slides.map(({ src, width, height }) => {
    const scale = Math.min(SLIDE_W / width, SLIDE_H / height);
    const left = (SLIDE_W - width * scale) / 2;
    const top = (SLIDE_H - height * scale) / 2;
    const image = {
      type: 'image', originX: 'left', originY: 'top', left, top, width, height,
      fill: 'rgb(0,0,0)', stroke: null, strokeWidth: 0, strokeDashArray: null, strokeLineCap: 'butt', strokeLineJoin: 'miter',
      strokeMiterLimit: 10, scaleX: scale, scaleY: scale, angle: 0, flipX: false, flipY: false, opacity: 1, shadow: null,
      visible: true, clipTo: null, backgroundColor: '', fillRule: 'nonzero', globalCompositeOperation: 'source-over',
      transformMatrix: null, skewX: 0, skewY: 0, src, filters: [], crossOrigin: '', alignX: 'none', alignY: 'none', meetOrSlice: 'meet',
    };
    const cx = left + (width * scale) / 2;
    const cy = top + (height * scale) / 2;
    const svg = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="${SLIDE_W}" height="${SLIDE_H}" viewBox="0 0 ${SLIDE_W} ${SLIDE_H}" xml:space="preserve">
<desc>Created with Fabric.js 1.6.0-rc.1</desc>
<defs></defs>
<g transform="translate(${cx} ${cy}) scale(${scale} ${scale})">
<image xlink:href="${src}" x="${-width / 2}" y="${-height / 2}" style="stroke: none; stroke-width: 0; stroke-dasharray: none; stroke-linecap: butt; stroke-linejoin: miter; stroke-miterlimit: 10; fill: rgb(0,0,0); fill-rule: nonzero; opacity: 1;" width="${width}" height="${height}" preserveAspectRatio="none"></image>
</g>
</svg>`;
    return {
      width: String(SLIDE_W), height: String(SLIDE_H), objectsDict: {}, svg_string: svg,
      canvasJSON: JSON.stringify({ objects: [image], background: '' }), version: '1.0',
    };
  });
  return {
    type: 'CanvasAnimation',
    mode: 'edit',
    content: {
      version: '1.0', width: SLIDE_W, height: SLIDE_H, canvasObjects,
      comp_id: uid('slides'), selectedCanvas: 0, keys: canvasObjects.map((_c, i) => i),
    },
    hash: 0,
    iteration: 0,
    children: [{ text: '' }],
  };
}

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

// Answers support Educative's FAQ widget ("FAQMarketing", listed as FAQs in the Answer editor). It renders
// questions and answers as Markdown and adds FAQPage structured data for search. (The FAQ Accordion
// widget belongs to another product and is not available in Answers.) Same content shape as FAQs saved
// from the editor: { faqs: [{ question, answer }], backgroundColor, emailAddress, comp_id }.
function makeFaqBlock(faqs: { question: string; answer: string }[]): any {
  return {
    type: 'FAQMarketing',
    mode: 'edit',
    content: {
      faqs: faqs.map((f) => ({ question: f.question, answer: f.answer })),
      backgroundColor: '',
      emailAddress: 'support@educative.io',
      comp_id: uid('faq'),
    },
    iteration: 0,
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
    const raw = segments[Number(parts[i])];
    // Only Markdown blocks render keyword popups; everywhere else a popup becomes its plain term.
    const seg: typeof raw = raw.kind === 'code' ? { ...raw, caption: stripKeywordSyntax(raw.caption) }
      : raw.kind === 'table' ? { ...raw, title: stripKeywordSyntax(raw.title), table: stripKeywordSyntax(raw.table) }
      : raw.kind === 'image' ? { ...raw, caption: stripKeywordSyntax(raw.caption), description: stripKeywordSyntax(raw.description) }
      : { ...raw, body: stripKeywordSyntax(raw.body) };
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
    } else if (/^latex$/i.test(seg.widget) && makeLatexBlocks(seg.body).length) {
      blocks.push(...makeLatexBlocks(seg.body));
    } else if (/^slides?$/i.test(seg.widget) && parseSlides(seg.body).length) {
      // Upload every slide image; if any is missing, fall back to a numbered list of the steps.
      const slides = parseSlides(seg.body);
      const uploaded = slides.every((sl) => sl.url)
        ? await Promise.all(slides.map((sl) => uploadImage(shotId, sl.url)))
        : [];
      if (uploaded.length && uploaded.every(Boolean)) {
        uploaded.forEach((u) => imageIds.push(u!.imageId));
        blocks.push(makeSlidesBlock(uploaded.map((u) => ({ src: `${EDUCATIVE_BASE}${ENDPOINTS.imagePath(shotId, u!.imageId)}`, width: 1280, height: 720 }))));
      } else {
        if (slides.some((sl) => sl.url)) imageFailures++;
        const steps = makeStepsBlock(seg.body);
        if (steps) blocks.push(steps);
      }
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

// Educative's tag catalog (the list its editor loads). A tag id it doesn't know shows as an empty chip on
// the Answer, so tags are mapped to known ids (by id or title) and unknown ones dropped.
let tagCatalog: Promise<Map<string, string>> | null = null;
function loadTagCatalog(): Promise<Map<string, string>> {
  tagCatalog ??= educativeFetch('/api/editorial/tags/get-all-tags?fetch_all=true')
    .then((d: any) => {
      const map = new Map<string, string>();
      const norm = (t: string) => String(t).toLowerCase().replace(/[^a-z0-9+#]+/g, '');
      for (const t of (Array.isArray(d?.tags) ? d.tags : [])) {
        if (!t?.id || String(t.id).endsWith('--category')) continue;
        map.set(norm(t.id), t.id);
        if (t.title && !map.has(norm(t.title))) map.set(norm(t.title), t.id);
      }
      return map;
    })
    .catch(() => { tagCatalog = null; return new Map<string, string>(); });
  return tagCatalog;
}

export async function knownTags(tags: string[]): Promise<string[]> {
  const catalog = await loadTagCatalog();
  if (!catalog.size) return tags; // catalog unavailable: keep tags as given
  const norm = (t: string) => String(t).toLowerCase().replace(/[^a-z0-9+#]+/g, '');
  return [...new Set(tags.map((t) => catalog.get(norm(t))).filter(Boolean) as string[])];
}

// Educative's own Answers search (the editor's /v2api/edpresso/search): published Answers only.
const answerSearchCache = new Map<string, { title: string; url: string }[]>();
export async function searchAnswers(query: string): Promise<{ title: string; url: string }[]> {
  const q = query.trim();
  if (!q || !isEducativeConfigured()) return [];
  if (answerSearchCache.has(q)) return answerSearchCache.get(q)!;
  let out: { title: string; url: string }[] = [];
  try {
    const d = await educativeFetch(`/v2api/edpresso/search?status=published&search_string=${encodeURIComponent(q)}&search_tags=&enable_edpresso_tags_revamp_learner_side=false`);
    out = (Array.isArray(d?.edpresso_shots) ? d.edpresso_shots : [])
      .filter((x: any) => x?.url && x?.title)
      .map((x: any) => ({ title: String(x.title).trim(), url: `${EDUCATIVE_BASE}/answers/${String(x.url).replace(/^\/+/, '')}` }));
  } catch {
    out = [];
  }
  answerSearchCache.set(q, out);
  return out;
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

// An existing Answer as readable Markdown-like text plus counts, for judging whether it needs a revamp.
export async function readAnswerForReview(shotId: string): Promise<{ title: string; url: string; text: string; stats: Record<string, number | string> }> {
  const shot = await educativeFetch(ENDPOINTS.save(shotId), { method: 'GET' }).catch((e: any) => {
    throw new Error(`Could not open Answer ${shotId} on Educative. Check the link and that the EDUCATIVE_FLASK_AUTH account can edit it. (${e?.message || e})`);
  });
  let c: any = shot?.content;
  if (typeof c === 'string') { try { c = JSON.parse(c); } catch { c = []; } }
  const blocks: any[] = Array.isArray(c) ? c : Array.isArray(c?.content) ? c.content : [];
  const stats: Record<string, number | string> = { blocks: blocks.length };
  const bump = (k: string) => { stats[k] = Number(stats[k] || 0) + 1; };
  const strip = (h: string) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const parts: string[] = [];
  for (const b of blocks) {
    const ct = b?.content || {};
    switch (b?.type) {
      case 'MarkdownEditor': parts.push(String(ct.text || '')); break;
      case 'SlateHTML': bump('callouts'); parts.push(`[Callout] ${strip(ct.html)}`); break;
      case 'Code': bump('code'); if (ct.runnable) bump('runnableCode');
        parts.push(`[Code widget, ${ct.language || 'text'}${ct.runnable ? ', runnable' : ', not runnable'}] Caption: ${ct.caption || '(none)'}\n\`\`\`\n${String(ct.content || '').slice(0, 3000)}\n\`\`\``); break;
      case 'Image': case 'DrawIOWidget': case 'MxGraphWidget': bump('images'); parts.push(`[Image] Caption: ${ct.caption || '(none)'}`); break;
      case 'CanvasAnimation': bump('slides'); parts.push(`[Slides widget: ${(ct.canvasObjects || []).length} slides]`); break;
      case 'Latex': bump('latex'); parts.push(`[Formula] ${ct.text || ''}`); break;
      case 'Table': bump('tables'); parts.push(`[Table] ${strip(JSON.stringify(ct.data || ct).slice(0, 1500))}`); break;
      case 'Quiz': bump('quiz'); parts.push(`[Quiz] ${(ct.questions || []).map((q: any) => q.questionText).join(' | ')}`); break;
      case 'StructuredQuiz': bump('pauseAndThink'); parts.push(`[Pause and think] ${(ct.questions || []).map((q: any) => `${q.questionText} -> ${q.answerText}`).join(' | ')}`); break;
      case 'FAQMarketing': case 'FaqAccordion': bump('faqWidgets'); stats.faqs = (ct.faqs || []).length;
        parts.push(`[FAQ widget]\n${(ct.faqs || []).map((f: any) => `Q: ${f.question}\nA: ${f.answer}`).join('\n')}`); break;
      case 'TerminalWidget': bump('terminals'); parts.push('[Terminal widget]'); break;
      default: bump('otherWidgets'); parts.push(`[${b?.type || 'Unknown'} widget]`);
    }
  }
  const text = parts.filter(Boolean).join('\n\n');
  // Body words as the generator counts them: text blocks only, without code explanations ("**Line N:**").
  const prose = parts.filter((p) => !p.startsWith('[')).join('\n\n');
  stats.bodyWords = countBodyWords(prose);
  stats.links = (text.match(/\]\(https?:\/\//g) || []).length;
  return { title: String(shot?.title || ''), url: String(shot?.url || ''), text, stats };
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
  programmingTags?: string[];
  slug?: string;
  shotId?: string;
  replaceExisting?: boolean;
}): Promise<EducativeDraft> {
  if (args.replaceExisting && !args.shotId) throw new Error('replaceExisting needs the existing Answer ID');
  const existing = args.replaceExisting ? await getAnswer(args.shotId!) : null;
  const tags = await knownTags(args.tags || []);
  // Existing programming tags come first (a live Answer keeps them), then new ones; unknown ids are dropped.
  const programmingTags = await knownTags([...String(existing?.programming_tags || '').split(','), ...(args.programmingTags || [])].map((t) => t.trim()).filter(Boolean));
  const shotId = args.shotId || await createShot();
  const { blocks, imageIds, imageFailures } = await buildAnswerBlocks(args.markdown, shotId);
  // Same body the editor's Save button sends. For a new Answer url stays empty: the editor only
  // sets it on publish.
  const shot = {
    title: args.title,
    tags: tags.join(',') || existing?.tags || '',
    programming_tags: programmingTags.join(',') || existing?.programming_tags || '',
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
