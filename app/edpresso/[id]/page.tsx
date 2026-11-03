'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { Stages, StageItem } from '@/app/_components/Stages';
import type { StageOutputMap, StageLogMap } from '@/app/_components/StageOutputs';
import { edpressoToHtml, edpressoToCopyMarkdown, countBodyWords, countSegments } from '@/lib/edpressoAssemble';

const ReactMarkdown = dynamic(() => import('react-markdown'), { ssr: false });
const StageOutputs = dynamic(
  () => import('@/app/_components/StageOutputs').then((m) => ({ default: m.StageOutputs })),
  { ssr: false },
);

const STAGE_ORDER = [
  'classify', 'competitor-research', 'link-discovery', 'link-verify', 'outline', 'writer',
  'reviewer', 'word-count', 'link-guard', 'seo-meta', 'images', 'assemble',
];

type View = 'preview' | 'copy' | 'links' | 'edit' | 'debug';

function CopyButton({ text, label = 'Copy', className = 'btn-secondary text-xs' }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
      }}
    >
      {copied ? 'Copied!' : label}
    </button>
  );
}

function CharCount({ value, min, max }: { value: string; min: number; max: number }) {
  const n = value.length;
  const ok = n >= min && n <= max;
  return <span className={`text-[11px] tabular-nums ${ok ? 'text-emerald-400' : 'text-amber-400'}`}>{n} chars (aim {min}–{max})</span>;
}

export default function EdpressoRunPage() {
  const { id: slugParam } = useParams<{ id: string }>();
  const id = slugParam.includes('--') ? slugParam.slice(slugParam.lastIndexOf('--') + 2) : slugParam;

  const [stages, setStages] = useState<StageItem[]>([]);
  const [outputs, setOutputs] = useState<StageOutputMap>({});
  const [logs, setLogs] = useState<StageLogMap>({});
  const [final, setFinal] = useState<any>(null);
  const [err, setErr] = useState('');
  const [running, setRunning] = useState(true);
  const [view, setView] = useState<View>('preview');

  const [draftMd, setDraftMd] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  const [origin, setOrigin] = useState('');

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => { setOrigin(window.location.origin); }, []);

  useEffect(() => {
    const ctl = new AbortController();
    abortRef.current = ctl;

    async function stream() {
      try {
        const res = await fetch(`/api/edpresso/${id}/stream`, { signal: ctl.signal });
        if (!res.ok || !res.body) {
          setErr('Failed to connect to pipeline stream');
          setRunning(false);
          return;
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split('\n\n');
          buf = parts.pop() || '';
          for (const line of parts) {
            if (!line.startsWith('data: ')) continue;
            try { handleEvent(JSON.parse(line.slice(6))); } catch {}
          }
        }
      } catch (e: any) {
        if (e?.name !== 'AbortError') setErr(e?.message || String(e));
      } finally {
        setRunning(false);
      }
    }

    function handleEvent(evt: any) {
      if (evt.type === 'stage') {
        setStages((s) => [...s, { name: evt.name, status: evt.status }]);
      } else if (evt.type === 'data' || (evt.type === 'stream' && evt.name)) {
        setOutputs((o) => ({ ...o, [evt.name]: evt.payload }));
      } else if (evt.type === 'log' && evt.name) {
        setLogs((l) => ({ ...l, [evt.name]: [...(l[evt.name] || []), evt.payload] }));
      } else if (evt.type === 'final') {
        setFinal(evt.payload);
      } else if (evt.type === 'error') {
        setErr(evt.message);
      } else if (evt.type === 'cancelled') {
        setErr('Generation cancelled');
      }
    }

    stream();
    return () => ctl.abort();
  }, [id]);

  async function stop() {
    try { await fetch(`/api/edpresso/${id}/cancel`, { method: 'POST' }); } catch {}
    abortRef.current?.abort();
  }

  function startEdit() {
    setDraftMd(final?.markdown || '');
    setSaveErr('');
    setView('edit');
  }

  async function saveEdit() {
    setSaving(true);
    setSaveErr('');
    try {
      const html = edpressoToHtml(draftMd);
      const res = await fetch(`/api/edpresso/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown: draftMd, html }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Save failed');
      setFinal((f: any) => ({ ...f, markdown: draftMd, html }));
      setView('preview');
    } catch (e: any) {
      setSaveErr(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  function download(content: string, name: string) {
    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  }

  const isDone = !running && !!final;
  const ed = final?.edpresso || {};
  const markdown: string = final?.markdown || '';
  // Everything below is derived from the saved Markdown so edits stay consistent.
  const html = useMemo(() => (markdown ? edpressoToHtml(markdown) : final?.html || ''), [markdown, final?.html]);
  const copyMarkdown = useMemo(() => (markdown ? edpressoToCopyMarkdown(markdown, origin) : ''), [markdown, origin]);
  const wordCount = useMemo(() => countBodyWords(markdown), [markdown]);
  const counts = useMemo(() => countSegments(markdown), [markdown]);
  const missingFaqs = useMemo(() => {
    const norm = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const present = new Set(
      (markdown.match(/\[\[FAQ widget\]\]([\s\S]*?)\[\[\/FAQ widget\]\]/)?.[1] || '')
        .split('\n').filter((l) => /^\s*Q:/.test(l)).map((l) => norm(l.replace(/^\s*Q:\s*/, ''))),
    );
    return ((ed.userFaqs || []) as string[]).filter((q) => !present.has(norm(q)));
  }, [markdown, ed.userFaqs]);
  const budget: number = ed.wordBudget || 0;
  const overBudget = budget > 0 && wordCount > budget;
  const liveText = typeof outputs['writer'] === 'string' ? outputs['writer'] : null;
  const hasDebug = stages.length > 0 || Object.keys(outputs).length > 0;
  const title = final?.title || '';

  const tabBtn = (v: View, label: string) => (
    <button
      className={`btn-secondary text-xs${view === v ? ' ring-1 ring-[var(--accent)]' : ''}`}
      onClick={() => setView((cur) => (cur === v ? 'preview' : v))}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-6">
      {/* ── Top bar ── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <Link href="/edpresso" className="text-sm text-[var(--text-dim)] hover:text-white">← Edpresso Shots</Link>
          <h1 className="mt-1.5 text-2xl font-bold tracking-tight break-words">
            {title || (running ? 'Generating Edpresso Shot…' : 'Edpresso Shot')}
          </h1>
          {final && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {ed.answerTypeLabel && <span className="pill">{ed.answerTypeLabel}</span>}
              {ed.language && ed.language !== 'none' && <span className="pill">{ed.language}</span>}
              {budget > 0 && (
                <span className={`pill ${overBudget ? 'pill-error' : 'pill-success'}`} title="Body words (excludes code, tables, images, widget placeholders, and FAQ answers)">
                  {wordCount} / {budget} words
                </span>
              )}
              {counts.code > 0 && <span className="pill pill-success">{counts.code} code</span>}
              {counts.table > 0 && <span className="pill pill-success">{counts.table} table</span>}
              {counts.image > 0 && <span className="pill pill-success">{counts.image} image</span>}
              {Object.entries(counts)
                .filter(([k]) => !['code', 'table', 'image'].includes(k))
                .map(([k, n]) => <span key={k} className="pill">{n} {k} placeholder</span>)}
              {Array.isArray(ed.verifiedLinks) && <span className="pill">{ed.verifiedLinks.length} verified links</span>}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2 items-center">
          {isDone && view === 'edit' && (
            <>
              {saveErr && <span className="text-xs text-red-300">{saveErr}</span>}
              <button className="btn-secondary" disabled={saving} onClick={() => setView('preview')}>Cancel</button>
              <button className="btn-primary" disabled={saving} onClick={saveEdit}>{saving ? 'Saving…' : 'Save'}</button>
            </>
          )}
          {isDone && view !== 'edit' && (
            <>
              {tabBtn('copy', 'Copy-ready Markdown')}
              {tabBtn('links', 'Links')}
              <button className="btn-secondary" onClick={startEdit}>Edit</button>
            </>
          )}
          {hasDebug && view !== 'edit' && (
            <button className="btn-secondary" onClick={() => setView((v) => (v === 'debug' ? 'preview' : 'debug'))}>
              {view === 'debug' ? 'Hide Debug' : 'Debug'}
            </button>
          )}
          {running && (
            <button className="btn-secondary" onClick={stop}>
              <span className="inline-block h-2.5 w-2.5 rounded-sm bg-red-400 mr-1" />
              Stop
            </button>
          )}
          {isDone && view !== 'edit' && (
            <CopyButton text={copyMarkdown} label="Copy for Educative" className="btn-primary" />
          )}
        </div>
      </div>

      {err && <div className="rounded-xl border border-red-500/40 bg-red-500/10 text-red-300 p-4 text-sm">{err}</div>}
      {isDone && missingFaqs.length > 0 && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 text-amber-300 p-4 text-sm">
          These FAQs you asked for are not in the FAQ widget word for word. Add them with Edit:
          <ul className="list-disc ml-5 mt-1">{missingFaqs.map((q) => <li key={q}>{q}</li>)}</ul>
        </div>
      )}

      {running && (
        <div className="space-y-4">
          {stages.length > 0 && <Stages items={stages} />}
          {liveText && view !== 'debug' && (
            <div className="card p-6">
              <p className="text-xs font-medium text-[var(--text-dim)] mb-3 uppercase tracking-wide">Live draft (streaming)</p>
              <div className="article-prose max-h-[500px] overflow-y-auto">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>{liveText}</ReactMarkdown>
              </div>
            </div>
          )}
          {view === 'debug' && Object.keys(outputs).length > 0 && (
            <StageOutputs outputs={outputs} logs={logs} order={STAGE_ORDER} defaultTab="writer" />
          )}
        </div>
      )}

      {isDone && (
        <>
          {/* ── Search listing + copy panel ── */}
          {view !== 'edit' && view !== 'debug' && (
            <div className="card p-5 grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="label">Answer title</span>
                  <CopyButton text={title} />
                </div>
                <div className="text-sm">{title}</div>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="label">Meta title</span>
                  <span className="flex items-center gap-2">
                    {ed.metaTitle && <CharCount value={ed.metaTitle} min={50} max={60} />}
                    <CopyButton text={ed.metaTitle || ''} />
                  </span>
                </div>
                <div className="text-sm">{ed.metaTitle || '—'}</div>
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="label">Meta description</span>
                  <span className="flex items-center gap-2">
                    {ed.metaDescription && <CharCount value={ed.metaDescription} min={140} max={155} />}
                    <CopyButton text={ed.metaDescription || ''} />
                  </span>
                </div>
                <div className="text-sm text-[var(--text-dim)]">{ed.metaDescription || '—'}</div>
              </div>
              {(ed.slug || ed.primaryKeyword) && (
                <div className="md:col-span-2 flex flex-wrap gap-x-6 gap-y-1 text-xs text-[var(--text-faint)]">
                  {ed.primaryKeyword && <span>Primary keyword: <span className="text-[var(--text-dim)]">{ed.primaryKeyword}</span></span>}
                  {ed.slug && <span>Suggested slug: <span className="font-mono text-[var(--text-dim)]">{ed.slug}</span></span>}
                </div>
              )}
            </div>
          )}

          {view === 'edit' ? (
            <div className="card p-6 space-y-3">
              <p className="text-xs text-[var(--text-dim)]">
                Edit the tagged Markdown. Keep the <code>[code]</code>, <code>[table]</code>, <code>[image]</code>, and <code>[[… widget]]</code> wrappers intact;
                the preview, word count, and copy-ready Markdown are rebuilt from this text when you save.
              </p>
              <textarea
                className="input w-full min-h-[70vh] font-mono text-xs"
                value={draftMd}
                onChange={(e) => setDraftMd(e.target.value)}
              />
              <div className="text-xs text-[var(--text-faint)]">Body words: {countBodyWords(draftMd)}{budget ? ` / ${budget}` : ''}</div>
            </div>
          ) : view === 'copy' ? (
            <div className="card p-6 space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--text-dim)]">Copy-ready Markdown</h3>
                  <p className="text-xs text-[var(--text-faint)] mt-1">
                    Paste into an Educative Markdown block. Move each <code>[[… widget]]</code> block into its matching widget (Code, Table, Image, Quiz, FAQ, Callout, Slides, LaTeX).
                  </p>
                </div>
                <div className="flex gap-2">
                  <CopyButton text={copyMarkdown} />
                  <button className="btn-secondary text-xs" onClick={() => download(copyMarkdown, `${ed.slug || 'edpresso-shot'}.md`)}>Download</button>
                </div>
              </div>
              <pre className="text-xs font-mono bg-[var(--panel-2)] border border-[var(--border)] p-4 rounded-xl overflow-auto max-h-[70vh] whitespace-pre-wrap break-words">
                {copyMarkdown}
              </pre>
            </div>
          ) : view === 'links' ? (
            <LinksReport ed={ed} />
          ) : view === 'debug' ? (
            <StageOutputs outputs={outputs} logs={logs} order={STAGE_ORDER} defaultTab="writer" />
          ) : (
            <article className="card p-8">
              <div className="article-prose" dangerouslySetInnerHTML={{ __html: html }} />
            </article>
          )}
        </>
      )}
    </div>
  );
}

function LinksReport({ ed }: { ed: any }) {
  const verified: any[] = ed.verifiedLinks || [];
  const rejected: any[] = ed.rejectedLinks || [];
  const removed: string[] = ed.removedLinks || [];
  return (
    <div className="card p-6 space-y-6 text-sm">
      <p className="text-xs text-[var(--text-dim)]">
        Every link candidate was requested over HTTP; only pages that loaded were offered to the writer, and any other URL in the draft was
        replaced with plain text.
      </p>
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Verified ({verified.length})</h3>
        {verified.length === 0 ? <p className="text-[var(--text-faint)]">None.</p> : (
          <ul className="space-y-1">
            {verified.map((l) => (
              <li key={l.url} className="flex gap-2 items-baseline">
                <span className={`pill py-0 text-[10px] ${l.kind === 'internal' ? 'pill-success' : ''}`}>{l.kind}</span>
                <a className="underline break-all" href={l.url} target="_blank" rel="noreferrer">{l.url}</a>
                {l.title && <span className="text-[var(--text-faint)]">— {l.title}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Rejected ({rejected.length})</h3>
        {rejected.length === 0 ? <p className="text-[var(--text-faint)]">None.</p> : (
          <ul className="space-y-1">
            {rejected.map((l) => (
              <li key={l.url} className="break-all text-[var(--text-dim)]">{l.url} <span className="text-[var(--text-faint)]">({l.reason})</span></li>
            ))}
          </ul>
        )}
      </section>
      {removed.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Removed from the draft ({removed.length})</h3>
          <ul className="space-y-1">
            {removed.map((u, i) => <li key={`${u}-${i}`} className="break-all text-[var(--text-dim)]">{u}</li>)}
          </ul>
        </section>
      )}
    </div>
  );
}
