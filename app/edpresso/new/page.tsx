'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Field } from '../../_components/Field';

// Mirrors ANSWER_TYPES in lib/edpressoPipeline.ts (kept separate so this client page doesn't pull in server code).
const ANSWER_TYPE_OPTIONS = [
  { value: 'auto',       label: 'Auto-detect from the title' },
  { value: 'error',      label: 'Error or troubleshooting (< 250 words)' },
  { value: 'function',   label: 'Function or API reference (< 500 words)' },
  { value: 'howto',      label: 'How-to with multiple methods (500–1,000 words)' },
  { value: 'concept',    label: 'Concept or algorithm (≤ 1,000 words)' },
  { value: 'technology', label: 'Technology or framework (≤ 1,000 words)' },
];

const LANGUAGES = ['Python', 'Java', 'JavaScript', 'TypeScript', 'C++', 'C#', 'C', 'Go', 'Rust', 'Ruby', 'PHP', 'Kotlin', 'Swift', 'SQL', 'Bash', 'R', 'Scala', 'Dart'];
const MAX_COMPETITOR_URLS = 3;

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60)
    .replace(/-$/, '');
}

export default function NewEdpressoPage() {
  const router = useRouter();

  const [title, setTitle] = useState('');
  const [keywords, setKeywords] = useState('');
  const [faqs, setFaqs] = useState('');
  const [language, setLanguage] = useState('');
  const [answerType, setAnswerType] = useState('auto');
  const [competitorUrls, setCompetitorUrls] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const competitorList = competitorUrls.split('\n').map((u) => u.trim()).filter(Boolean);
  const badCompetitor = competitorList.find((u) => !/^https?:\/\/\S+$/i.test(u));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (competitorList.length > MAX_COMPETITOR_URLS) { setErr(`Add at most ${MAX_COMPETITOR_URLS} competitor URLs.`); return; }
    if (badCompetitor) { setErr(`Competitor URL must start with http:// or https:// — "${badCompetitor}"`); return; }
    setBusy(true);
    setErr('');
    try {
      const res = await fetch('/api/edpresso', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          keywords,
          faqs,
          language: language.trim(),
          answerType,
          competitorUrls: competitorList.join('\n'),
        }),
      });
      if (!res.ok || !res.body) { setErr('Request failed'); setBusy(false); return; }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let runId = '';

      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';
        for (const line of parts) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === 'meta' && evt.blogId) { runId = evt.blogId; break outer; }
          } catch {}
        }
      }

      reader.cancel().catch(() => {});

      if (runId) {
        const slug = slugify(title);
        router.push(slug ? `/edpresso/${slug}--${runId}` : `/edpresso/${runId}`);
      } else {
        setErr('Failed to start pipeline — no run ID received');
        setBusy(false);
      }
    } catch (e: any) {
      setErr(e?.message || String(e));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <span className="pill mb-3">Edpresso Shots</span>
        <h1 className="text-3xl font-bold tracking-tight">
          New <span className="brand-gradient">Edpresso Shot</span>
        </h1>
        <p className="mt-2 text-[var(--text-dim)] max-w-2xl text-sm">
          The pipeline researches competitors and People-also-ask questions, finds links it can confirm exist,
          and writes an Educative Answer sized to its type. Code, tables, and images are generated; quiz, FAQ,
          callout, and slides come as placeholders ready to paste into their widgets.
        </p>
      </div>

      <form onSubmit={submit} className="card p-6 space-y-5">
        <Field label="Title or search query" hint='Phrase it the way people search, e.g. "How to generate random numbers in Java".'>
          <input
            className="input"
            required
            placeholder="How to concatenate strings in Python"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>

        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Answer type">
            <select className="input" value={answerType} onChange={(e) => setAnswerType(e.target.value)}>
              {ANSWER_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
          <Field label="Programming language (optional)" hint="Leave blank to use the language in the title, or the most common one for the topic.">
            <input
              className="input"
              list="edpresso-languages"
              placeholder="e.g. Java"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            />
            <datalist id="edpresso-languages">
              {LANGUAGES.map((l) => <option key={l} value={l} />)}
            </datalist>
          </Field>
        </div>

        <Field label="Target keywords" hint="Comma- or line-separated. Include the main phrase, related terms, and long-tail variants.">
          <textarea
            className="input min-h-[90px] text-sm"
            placeholder="java random number, random number generator, math.random java, securerandom"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
          />
        </Field>

        <Field label="FAQs" hint={'One question per line, worded as people search. The pipeline keeps all of them and adds 3–5 from "People also ask".'}>
          <textarea
            className="input min-h-[140px] text-sm"
            placeholder={'How to generate a random number between 1 and 10 in Java?\nWhat is a seed value?'}
            value={faqs}
            onChange={(e) => setFaqs(e.target.value)}
          />
        </Field>

        <Field label={`Competitor URLs (optional, up to ${MAX_COMPETITOR_URLS})`} hint="One per line. These pages are analyzed for gaps but never linked.">
          <textarea
            className="input min-h-[80px] font-mono text-xs"
            placeholder="https://…"
            value={competitorUrls}
            onChange={(e) => setCompetitorUrls(e.target.value)}
          />
        </Field>

        <div className="flex items-center gap-3 pt-1">
          <button disabled={busy} className="btn-primary">
            {busy ? (
              <>
                <span className="h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                Starting…
              </>
            ) : (
              <>
                Generate Edpresso Shot
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M5 12h14M13 5l7 7-7 7" />
                </svg>
              </>
            )}
          </button>
          <span className="text-xs text-[var(--text-faint)]">Usually 2–5 minutes</span>
        </div>
      </form>

      {err && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 text-red-300 p-4 text-sm">{err}</div>
      )}
    </div>
  );
}
