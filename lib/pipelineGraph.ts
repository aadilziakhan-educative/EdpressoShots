// Declarative graph of the Edpresso Shots pipeline. The /graph page renders this verbatim,
// laid out top-to-bottom (vertical).
//
// **Single source of truth.** When you add a stage to `lib/edpressoPipeline.ts`:
//   1. Append a Node here. The `id` MUST equal the `emit({ type:'stage', name })` value so the
//      live progress tracker and this static graph stay aligned.
//   2. Connect it with Edge entries. Use `when` to label conditional branches.
//      Edges WITHOUT `when` are unconditional flow.
//   3. Set `rank` = depth from top (0 at the top). Set `lane` = horizontal column (0 = center,
//      negatives go left, positives go right). Same `(rank, lane)` cell = collision; the
//      renderer assumes one node per cell.
//
// Conventions:
// - `agent` describes the worker that handles the node so the visualizer can color/badge it.
// - `prompt` is the registry name from `lib/edpressoPromptsRegistry.ts` — the visualizer links it to
//   `/prompts/{name}` so registry edits flow back into the live pipeline.

export type AgentKind =
  | 'openai-search' // GPT search-preview / search-api (web research)
  | 'gemini-text'   // Google Gemini (drafting / rewriting)
  | 'gemini-review' // Google Gemini (review/critique)
  | 'transform'     // Pure code (no LLM): regex, parsing, formatting
  | 'http'          // External HTTP call (e.g. d2 svg upload, Educative publish)
  | 'fanout'        // Logical join/split node (no work, just wiring)
  | 'terminal';     // start / end / final

export interface GraphNode {
  id: string;
  label: string;
  agent: AgentKind;
  prompt?: string;
  model?: string;
  notes?: string;
  rank: number;   // 0 = top
  lane: number;   // 0 = center, negative = left, positive = right
}

export interface GraphEdge {
  from: string;
  to: string;
  when?: string;          // condition label drawn on the edge
  style?: 'solid' | 'dashed';
}

export interface PipelineGraph {
  id: string;
  title: string;
  description: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// Edpresso Shots pipeline (lib/edpressoPipeline.ts → runEdpressoPipeline)
// ---------------------------------------------------------------------------
//
//    start → classify
//      ┌──────────────┴──────────────┐
//  competitor-research          link-discovery
//      └──────────────┬──────────────┘
//                link-verify (HTTP)
//                  outline
//                  writer (streaming)
//                  reviewer (×2 if over budget) + Quiz/FAQ fact-check
//                  link-guard
//      ┌──────────────┴──────────────┐
//   seo-meta                       images
//      └──────────────┬──────────────┘
//                  assemble → end (copy-paste; no publish)
//
export const edpressoGraph: PipelineGraph = {
  id: 'edpresso',
  title: 'Edpresso Shots pipeline',
  description:
    'Classify the Answer type → competitor research and link discovery in parallel → HTTP-verify every link → ' +
    'outline → write (code and tables inline) → checklist review against the word budget → strip unverified links → ' +
    'SEO meta and images in parallel → assemble preview and copy-ready Markdown.',
  nodes: [
    { id: 'ed-start',               label: 'Start',                        agent: 'terminal',                                                                                   rank: 0,  lane: 0 },
    { id: 'ed-classify',            label: 'Classify Answer type',         agent: 'gemini-text',   prompt: 'edpresso-classify',            notes: 'Uses the author’s type if set; infers language if blank.', rank: 1, lane: 0 },
    { id: 'ed-competitor-research', label: 'Competitor research + PAA',    agent: 'openai-search', prompt: 'edpresso-competitor-research', notes: 'Includes optional competitor URLs.',                rank: 2,  lane: -1 },
    { id: 'ed-link-discovery',      label: 'Link discovery',               agent: 'openai-search', prompt: 'edpresso-link-discovery',      notes: 'educative.io, how.dev, official docs.',             rank: 2,  lane: 1 },
    { id: 'ed-link-verify',         label: 'Verify links (HTTP)',          agent: 'http',                                                  notes: 'Keeps 2xx pages; drops competitors.',               rank: 3,  lane: 0 },
    { id: 'ed-outline',             label: 'Outline',                      agent: 'gemini-text',   prompt: 'edpresso-outline',                                                                  rank: 4,  lane: 0 },
    { id: 'ed-writer',              label: 'Writer',                       agent: 'gemini-text',   prompt: 'edpresso-writer',              notes: 'Streams; writes code and tables inline.',           rank: 5,  lane: 0 },
    { id: 'ed-reviewer',            label: 'Checklist review',             agent: 'gemini-review', prompt: 'edpresso-reviewer',            notes: 'Body only; second pass if >10% over budget. Then Quiz + FAQ fact-check (edpresso-widget-review).', rank: 6, lane: 0 },
    { id: 'ed-link-guard',          label: 'Remove unverified links',      agent: 'transform',                                                                                                  rank: 7,  lane: 0 },
    { id: 'ed-seo-meta',            label: 'Meta title + description',     agent: 'gemini-text',   prompt: 'edpresso-seo-meta',                                                                 rank: 8,  lane: -1 },
    { id: 'ed-images',              label: 'Generate images',              agent: 'http',                                                  notes: 'Per [image] tag — GPT Image.',                      rank: 8,  lane: 1 },
    { id: 'ed-assemble',            label: 'Assemble',                     agent: 'transform',                                             notes: 'Preview HTML + copy-ready Markdown.',               rank: 9,  lane: 0 },
    { id: 'ed-end',                 label: 'Done (copy into Educative)',   agent: 'terminal',                                                                                                   rank: 10, lane: 0 },
  ],
  edges: [
    { from: 'ed-start',               to: 'ed-classify' },
    { from: 'ed-classify',            to: 'ed-competitor-research' },
    { from: 'ed-classify',            to: 'ed-link-discovery' },
    { from: 'ed-competitor-research', to: 'ed-link-verify' },
    { from: 'ed-link-discovery',      to: 'ed-link-verify' },
    { from: 'ed-link-verify',         to: 'ed-outline' },
    { from: 'ed-outline',             to: 'ed-writer' },
    { from: 'ed-writer',              to: 'ed-reviewer' },
    { from: 'ed-reviewer',            to: 'ed-link-guard' },
    { from: 'ed-link-guard',          to: 'ed-seo-meta' },
    { from: 'ed-link-guard',          to: 'ed-images',          when: '[image] tags' },
    { from: 'ed-seo-meta',            to: 'ed-assemble' },
    { from: 'ed-images',              to: 'ed-assemble' },
    { from: 'ed-assemble',            to: 'ed-end' },
  ],
};

export const ALL_GRAPHS: PipelineGraph[] = [edpressoGraph];
