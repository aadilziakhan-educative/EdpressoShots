'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type PromptItem = {
  name: string;
  variables: string[];
  editable: boolean;
  version: number;
  updatedAt?: string;
  pipeline: string;
};

function PromptRow({ p }: { p: PromptItem }) {
  const inner = (
    <div className="flex items-center gap-4 px-4 py-3 group transition-colors hover:bg-[var(--panel-2)]">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-mono font-medium" style={{ color: 'var(--text)' }}>{p.name}</div>
        <div className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--text-faint)' }}>
          {p.variables.length ? `vars: ${p.variables.join(', ')}` : 'no variables'}
        </div>
      </div>
      <div className="text-xs tabular-nums w-14 text-right" style={{ color: 'var(--text-faint)' }}>
        v{p.version}
      </div>
      <div className="text-xs w-40 text-right" style={{ color: 'var(--text-faint)' }}>
        {p.updatedAt ? new Date(p.updatedAt).toLocaleString() : 'default'}
      </div>
      <span className={`pill shrink-0 ${p.editable ? 'pill-success' : 'pill-error'}`}>
        {p.editable ? 'editable' : 'code-only'}
      </span>
    </div>
  );

  if (!p.editable) return <div className="opacity-50 cursor-not-allowed">{inner}</div>;
  return <Link href={`/prompts/${p.name}`}>{inner}</Link>;
}

export default function PromptsPage() {
  const [items, setItems] = useState<PromptItem[]>([]);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    try {
      const res = await fetch('/api/prompts');
      setItems((await res.json()).prompts || []);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { refresh(); }, []);

  return (
    <div className="max-w-5xl space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--text)' }}>Prompts</h1>
          <p className="mt-0.5 text-sm" style={{ color: 'var(--text-dim)' }}>
            Edit prompt templates for every pipeline stage. Changes save to disk and take effect on the next run.
          </p>
        </div>
        <button onClick={refresh} className="btn-secondary text-xs">Refresh</button>
      </div>

      {/* Content */}
      {loading ? (
        <div className="card px-4 py-6 text-sm" style={{ color: 'var(--text-faint)' }}>Loading…</div>
      ) : items.length === 0 ? (
        <div className="card px-4 py-6 text-sm" style={{ color: 'var(--text-faint)' }}>No prompts registered yet.</div>
      ) : (
        <div className="card divide-rows">
          {items.map((p) => <PromptRow key={p.name} p={p} />)}
        </div>
      )}
    </div>
  );
}
