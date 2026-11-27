// Edpresso Shot assembly — pure functions, safe to import on both server and client.
//
// The saved `markdown` of an Edpresso Shot is the single source of truth. It holds prose plus:
//   [code]Language: …\nCaption: …\n```lang …```[/code]              → code widget
//   [table]Table title: …\n| … |[/table]                             → table widget
//   [image][Description]…[/Description][Caption]…[/Caption][Url]…[/Url][/image] → image widget
//   [[Quiz widget]] … [[/Quiz widget]]  (also FAQ, Callout, Slides, LaTeX…) → widget placeholder
//   #key# term: definition #key#                                        → Educative keyword popup
//
// From it we derive (1) preview HTML for the reader page, (2) the copy-ready Markdown an editor
// pastes into the Educative Answers editor, and (3) the body word count used for the length budget.

import { marked } from 'marked';
import katex from 'katex';
import { buildCodeWidget, buildTableWidget } from './transforms';

const SEGMENT_RE = /\[(code|table|image)\]([\s\S]*?)\[\/\1\]|\[\[([A-Za-z][A-Za-z ]*?) widget\]\]([\s\S]*?)\[\[\/\3 widget\]\]/g;
const KEY_RE = /#key#\s*([^:#]+?)\s*:\s*([\s\S]*?)\s*#key#/g;

export type EdpressoSegment =
  | { kind: 'code'; language: string; caption: string; code: string }
  | { kind: 'table'; title: string; table: string }
  | { kind: 'image'; description: string; caption: string; url: string }
  | { kind: 'placeholder'; widget: string; body: string };

export function parseCodeTag(inner: string): { language: string; caption: string; code: string } {
  const langM = inner.match(/^\s*Language:\s*(.*)$/im);
  const capM = inner.match(/^\s*Caption:\s*(.*)$/im);
  const fenceM = inner.match(/```([a-zA-Z0-9+#_-]*)[^\n]*\n([\s\S]*?)```/);
  const language = ((langM?.[1] || fenceM?.[1] || 'text').trim().split(/[\s,|/]+/)[0] || 'text').toLowerCase();
  const code = fenceM
    ? fenceM[2].replace(/\s+$/, '')
    : inner.replace(/^\s*(Language|Caption):.*$/gim, '').trim();
  return { language, caption: (capM?.[1] || '').trim(), code };
}

export function parseTableTag(inner: string): { title: string; table: string } {
  const titleM = inner.match(/^\s*Table title:\s*(.*)$/im);
  const table = inner.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|')).join('\n');
  return { title: (titleM?.[1] || '').trim(), table };
}

export function parseImageTag(inner: string): { description: string; caption: string; url: string } {
  const pick = (tag: string) => (inner.match(new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[\\/${tag}\\]`, 'i'))?.[1] || '').trim();
  const description = pick('Description');
  // The caption doubles as alt text, so a missing or generic one is rebuilt from the description.
  return { description, caption: imageAltText(pick('Caption'), description), url: pick('Url') };
}

// Educative keyword popups. Its Markdown renderer only recognizes "#key# term: meaning #key#" with one
// space inside each marker, a term without ":", and no "#", "|", "^", or line break in either part.
// Repairs near-misses to that exact form; a popup that can't be repaired becomes its plain term.
export function normalizeKeywordSyntax(md: string): string {
  const clean = (t: string) => t.replace(/\s+/g, ' ').replace(/\|/g, '/').replace(/[#^]/g, '').trim();
  const kept: string[] = [];
  return String(md || '')
    .replace(/#key#([\s\S]*?)#key#/g, (_m, inner: string) => {
      const flat = inner.replace(/\s+/g, ' ').trim();
      const at = flat.indexOf(':');
      const term = clean(at > 0 ? flat.slice(0, at) : flat);
      const meaning = clean(at > 0 ? flat.slice(at + 1) : '');
      if (!term || !meaning) return term;
      kept.push(`#key# ${term}: ${meaning} #key#`);
      return `\u0000KEY${kept.length - 1}\u0000`;
    })
    // An unpaired marker left over is dropped.
    .replace(/[ \t]?#key#[ \t]?/g, ' ')
    .replace(/\u0000KEY(\d+)\u0000/g, (_m, i) => kept[Number(i)]);
}

// For blocks that are not Markdown (Callout, Quiz, FAQ, tables, captions): the "#key#" text syntax would
// show literally there, so a popup becomes its plain term.
export function stripKeywordSyntax(text: string): string {
  return normalizeKeywordSyntax(text).replace(/#key# ([^:]+?): [^#]*? #key#/g, '$1');
}

// Slides widget body: one "Slide N: <what the slide image shows>" line per slide, plus [Url]…[/Url]
// once the slide's image is generated.
export function parseSlides(body: string): { text: string; url: string }[] {
  return String(body || '').split('\n')
    .map((l) => l.match(/^\s*(?:slide|step)\s*\d+\s*[:.)-]\s*(.*)$/i)?.[1] || '')
    .filter((l) => l.trim())
    .map((l) => ({
      text: l.replace(/\[Url\][\s\S]*?\[\/Url\]/i, '').trim(),
      url: (l.match(/\[Url\]([\s\S]*?)\[\/Url\]/i)?.[1] || '').trim(),
    }));
}

// Educative's Image widget has no separate alt field: the published Answer page renders the caption
// as the image's alt and title (an empty caption becomes the generic alt "image widget"). So the
// caption is the alt text, and it must describe what the image shows.
export const ALT_TEXT_MAX = 125;
const GENERIC_ALT_RE = /^(an?\s+|the\s+)?(image|picture|diagram|illustration|figure|graphic|screenshot|chart|visual)(\s+\d+)?\.?$/i;

export function imageAltText(caption: string, description: string): string {
  const clean = (s: string) => s.replace(/\s+/g, ' ').replace(/^(an?\s+)?(image|picture|illustration|diagram)\s+(of|showing)\s+/i, '').trim();
  const fit = (s: string) => {
    if (s.length <= ALT_TEXT_MAX) return s;
    let cut = s.slice(0, ALT_TEXT_MAX + 1).replace(/\s+\S*$/, '');
    // Don't end on a dangling connector ("… and then").
    for (let prev = ''; prev !== cut;) {
      prev = cut;
      cut = cut.replace(/[,;:\s-]+$/, '').replace(/\s+(and|or|then|to|of|the|a|an|with|into|until|for|from|by|in|on|at|as|which|that|while)$/i, '');
    }
    return cut || s.slice(0, ALT_TEXT_MAX);
  };
  const cap = clean(caption || '');
  if (cap && !GENERIC_ALT_RE.test(cap) && cap.split(' ').length >= 3) return fit(cap.charAt(0).toUpperCase() + cap.slice(1));
  // Fall back to the first sentence of the description, minus "The illustration shows …" framing.
  const first = clean((description || '').split(/(?<=[.!?])\s+/)[0] || '')
    .replace(/^(the|this)\s+(illustration|image|diagram|figure|picture|graphic)\s+(shows|depicts|illustrates|displays)\s+/i, '')
    .replace(/\.$/, '');
  if (first) return fit(first.charAt(0).toUpperCase() + first.slice(1));
  return cap;
}

// Split the tagged Markdown into prose (with EDPSEG tokens) and ordered widget segments.
export function splitSegments(markdown: string): { prose: string; segments: EdpressoSegment[] } {
  const segments: EdpressoSegment[] = [];
  const prose = String(markdown || '').replace(SEGMENT_RE, (_m, tag, tagInner, widget, widgetBody) => {
    if (tag === 'code') segments.push({ kind: 'code', ...parseCodeTag(tagInner) });
    else if (tag === 'table') segments.push({ kind: 'table', ...parseTableTag(tagInner) });
    else if (tag === 'image') segments.push({ kind: 'image', ...parseImageTag(tagInner) });
    else segments.push({ kind: 'placeholder', widget: String(widget).trim(), body: String(widgetBody).trim() });
    return `\n\nEDPSEG${segments.length - 1}TOKEN\n\n`;
  });
  return { prose, segments };
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Keyword popups render as a dotted-underline term with the definition on hover.
function renderKeywordPopups(md: string): string {
  return md.replace(KEY_RE, (_m, term, def) =>
    `<span class="edp-key" title="${escapeHtml(def)}">${escapeHtml(term)}</span>`);
}

function mdToHtml(md: string, breaks = false): string {
  return (marked.parse(renderKeywordPopups(md), { async: false, gfm: true, breaks }) as string)
    .replace(/\sid="[^"]*"/g, '');
}

function segmentHtml(seg: EdpressoSegment, order: number): string {
  if (seg.kind === 'code') return buildCodeWidget({ language: seg.language, code: seg.code, caption: seg.caption }, order).html;
  if (seg.kind === 'table') return buildTableWidget(`Table title: ${seg.title}\n${seg.table}`, order).html;
  if (seg.kind === 'image') {
    if (seg.url) {
      return `<figure class="widget-image" data-order="${order}"><img src="${escapeHtml(seg.url)}" alt="${escapeHtml(seg.caption)}" style="max-width:100%;border-radius:8px;" />${seg.caption ? `<figcaption>${escapeHtml(seg.caption)}</figcaption>` : ''}</figure>`;
    }
    return placeholderHtml('Image', `**Image not generated.** ${seg.description}${seg.caption ? `\n\nCaption: ${seg.caption}` : ''}`);
  }
  if (seg.widget === 'Callout') return `<aside class="edp-callout">${mdToHtml(seg.body, true)}</aside>`;
  if (/^latex$/i.test(seg.widget)) {
    // One rendered formula per blank-line-separated block, as on Educative.
    const parts = seg.body.replace(/^\s*\$\$|\$\$\s*$/g, '').split(/\n\s*\n/).map((f) => f.trim()).filter(Boolean);
    try {
      return parts.map((f) => `<div class="edp-latex">${katex.renderToString(f, { displayMode: true, throwOnError: true })}</div>`).join('');
    } catch {
      return placeholderHtml('LaTeX (invalid formula)', `\`\`\`\n${seg.body}\n\`\`\``);
    }
  }
  if (/^slides?$/i.test(seg.widget)) {
    const slides = parseSlides(seg.body);
    const item = (sl: { text: string; url: string }, i: number) => sl.url
      ? `<figure class="edp-slide"><img src="${escapeHtml(sl.url)}" alt="${escapeHtml(sl.text)}" style="max-width:100%;border-radius:8px;" /><figcaption>Slide ${i + 1} of ${slides.length}: ${escapeHtml(sl.text)}</figcaption></figure>`
      : `<li>${mdToHtml(sl.text, true).replace(/^<p>|<\/p>\s*$/g, '')}</li>`;
    return slides.every((sl) => sl.url)
      ? `<div class="edp-widget"><div class="edp-widget-label">Slides widget · ${slides.length} slides</div>${slides.map(item).join('')}</div>`
      : `<ol>${slides.map(item).join('')}</ol>`;
  }
  if (seg.widget === 'Terminal') {
    const lines = seg.body.replace(/^\s*```[\w-]*\s*$/gm, '').split('\n').filter((l) => l.trim());
    return `<pre class="edp-terminal">${lines.map((l) => (/^\s*(Setup|Try):\s*$/i.test(l) ? `# ${escapeHtml(l.trim())}` : `$ ${escapeHtml(l.trim().replace(/^\$\s?/, ''))}`)).join('\n')}</pre>`;
  }
  return placeholderHtml(seg.widget, seg.body);
}

function placeholderHtml(widget: string, body: string): string {
  return `<div class="edp-widget"><div class="edp-widget-label">${escapeHtml(widget)} widget · placeholder</div><div class="edp-widget-body">${mdToHtml(body, true)}</div></div>`;
}

// Preview HTML for the reader page.
export function edpressoToHtml(markdown: string): string {
  const { prose, segments } = splitSegments(markdown);
  let html = mdToHtml(prose);
  segments.forEach((seg, i) => {
    const token = `EDPSEG${i}TOKEN`;
    const rendered = segmentHtml(seg, i + 1);
    html = html.split(`<p>${token}</p>`).join(rendered).split(token).join(rendered);
  });
  return html;
}

// Copy-ready Markdown for the Educative Answers editor. Prose and #key# popups stay as-is (the
// Educative Markdown block understands both); every widget is wrapped in visible [[… widget]]
// markers so the editor knows exactly what to move into which widget.
export function edpressoToCopyMarkdown(markdown: string, origin = ''): string {
  const { prose, segments } = splitSegments(markdown);
  let out = prose;
  segments.forEach((seg, i) => {
    let block: string;
    if (seg.kind === 'code') {
      block = `[[Code widget — language: ${seg.language}${seg.caption ? ` — caption: "${seg.caption}"` : ''}]]\n\`\`\`${seg.language}\n${seg.code}\n\`\`\`\n[[/Code widget]]`;
    } else if (seg.kind === 'table') {
      block = `[[Table widget${seg.title ? ` — caption: "${seg.title}"` : ''}]]\n${seg.table}\n[[/Table widget]]`;
    } else if (seg.kind === 'image') {
      const src = seg.url ? (seg.url.startsWith('/') ? `${origin}${seg.url}` : seg.url) : '';
      block = `[[Image widget${seg.caption ? ` — caption: "${seg.caption}"` : ''}]]\n${src ? `![${seg.caption}](${src})\n` : ''}Description: ${seg.description}\n[[/Image widget]]`;
    } else {
      block = `[[${seg.widget} widget]]\n${seg.body}\n[[/${seg.widget} widget]]`;
    }
    out = out.split(`EDPSEG${i}TOKEN`).join(block);
  });
  return out.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// Body words: prose only. Code, tables, images, widget placeholders (including the FAQ and quiz)
// are excluded; a keyword popup counts as its term only.
// Body words: prose only. Code, tables, images, widgets, FAQ answers, and the line-by-line code
// explanations ("**Line 5:** …", "**Lines 6-9:** …") don't count: those explanations belong to the
// playgrounds and shouldn't compete with the explanation for the word budget.
export function countBodyWords(markdown: string): number {
  const prose = String(markdown || '')
    .replace(SEGMENT_RE, ' ')
    .replace(/^[ \t]*\*\*Lines?\s+\d+(?:\s*[–—-]\s*\d+)?\s*:?\s*\*\*.*$/gim, ' ')
    .replace(KEY_RE, '$1')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#>*_`|~-]+/g, ' ');
  return (prose.match(/[A-Za-z0-9][\w'’.+#()-]*/g) || []).length;
}

export function countSegments(markdown: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const seg of splitSegments(markdown).segments) {
    const key = seg.kind === 'placeholder' ? seg.widget.toLowerCase() : seg.kind;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}
