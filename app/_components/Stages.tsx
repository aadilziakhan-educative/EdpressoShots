export type StageItem = { name: string; status: 'start' | 'done' | 'error' };

const PRETTY: Record<string, string> = {
  classify: 'Classify Answer type',
  'competitor-research': 'Competitor research + People also ask',
  'link-discovery': 'Find internal and official links',
  'link-verify': 'Verify links (HTTP)',
  writer: 'Write Answer',
  reviewer: 'Checklist review + word budget',
  'word-count': 'Word count',
  'link-guard': 'Remove unverified links',
  'seo-meta': 'Meta title + description',
  images: 'Generate images (gpt-image-2)',
  assemble: 'Assemble preview + copy-ready Markdown',
  'image-generation': 'Generate images (gpt-image-2)',
};

export const STAGE_LABELS = PRETTY;

// Per-image sub-stages clutter the high-level pipeline tracker; they're already shown as sub-tabs
// inside StageOutputs. Filter them out of the progress card.
const WIDGET_SUB_RE = /^image-generate#/;

export function Stages({ items }: { items: StageItem[] }) {
  if (!items.length) return null;
  // collapse to one entry per name with latest status
  const map = new Map<string, StageItem>();
  for (const it of items) map.set(it.name, it);
  // Drop per-widget sub-stages from the tracker.
  for (const k of Array.from(map.keys())) {
    if (WIDGET_SUB_RE.test(k)) map.delete(k);
  }
  const list = Array.from(map.values());
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">Pipeline progress</h3>
        <span className="text-[11px] text-[var(--text-faint)]">{list.filter((s) => s.status === 'done').length}/{list.length} stages</span>
      </div>
      <ul className="grid sm:grid-cols-2 gap-2">
        {list.map((s) => (
          <li
            key={s.name}
            className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2"
          >
            <span
              className={
                s.status === 'done'
                  ? 'h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.7)]'
                  : s.status === 'error'
                  ? 'h-2 w-2 rounded-full bg-red-400'
                  : 'h-2 w-2 rounded-full bg-amber-400 dot-running shadow-[0_0_8px_rgba(245,158,11,0.7)]'
              }
            />
            <span className="text-sm flex-1 truncate">{PRETTY[s.name] || s.name}</span>
            <span
              className={
                s.status === 'done'
                  ? 'pill pill-success'
                  : s.status === 'error'
                  ? 'pill pill-error'
                  : 'pill pill-running'
              }
            >
              {s.status === 'done' ? 'done' : s.status === 'error' ? 'error' : 'running'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
