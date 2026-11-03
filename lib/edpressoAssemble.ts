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
  return { description: pick('Description'), caption: pick('Caption'), url: pick('Url') };
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
export function countBodyWords(markdown: string): number {
  const prose = String(markdown || '')
    .replace(SEGMENT_RE, ' ')
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
