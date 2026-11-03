# EdpressoShots

Generate Edpresso Shots (Educative Answers) optimized for SEO, GEO, AEO and AIO.

An internal Next.js tool that runs a multi-stage AI pipeline to produce a short, search-first Educative Answer. Stage output streams in real time, links are HTTP-verified, and images are generated in parallel. The result is copy-pasted into the Educative Answers editor. There is no publish step.

## Run locally

```bash
git clone https://github.com/aadilziakhan-educative/EdpressoShots.git
cd EdpressoShots
cp .env.example .env.local   # add your OpenAI API key
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). No login is required.

> **Node.js version:** 20 or later is required.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | **Yes** | Drives text generation, web research and image generation |
| `OPENAI_MODEL_DEFAULT` | No | Default model (`gpt-5.4`) |
| `OPENAI_MODEL_TEXTGEN` | No | Writer model (`gpt-5.4`) |
| `OPENAI_MODEL_LIGHT` | No | Fast model for small calls (`gpt-5.4-mini`) |
| `OPENAI_SEARCH_MODEL` | No | Web search model (`gpt-5-search-api`) |

## What's inside

| Page | Route | Description |
|---|---|---|
| Edpresso Shots | `/edpresso` | List of Shots with search, status filter, stop and delete |
| New Shot | `/edpresso/new` | Input form. On submit it redirects to `/edpresso/{slug}--{id}` |
| Shot detail | `/edpresso/[id]` | Live progress, preview, copy-ready Markdown, meta title and description, link report, Markdown editor |
| Pipeline Graph | `/graph` | Visual DAG of every pipeline stage |
| Prompts | `/prompts` | Edit the prompt template for each stage. Edits take effect on the next run |

## How the pipeline works

The pipeline lives in `lib/edpressoPipeline.ts`. Its prompts are in `lib/edpressoPrompts.ts` and are registered for editing in `lib/edpressoPromptsRegistry.ts`.

**Inputs:** a title or search query, target keywords, FAQs (one per line), an optional language, an Answer type (or auto-detect), and up to 3 optional competitor URLs.

**Answer types and body word budgets** (`ANSWER_TYPES`):

| Answer type | Body word budget |
|---|---|
| Error | under 250 |
| Function or API | under 500 |
| How-to with multiple methods | 500 to 1,000 |
| Concept | up to 1,000 |
| Technology | up to 1,000 |

Each type has its own section structure, which is passed into the prompts as a string. Body word counts exclude code, tables, images, widget placeholders and FAQ answers.

**Stages:**

1. `classify` picks the Answer type and language.
2. `competitor-research` and `link-discovery` run web searches in parallel.
3. `link-verify` sends an HTTP GET to every candidate link, keeps 2xx responses and drops competitor domains.
4. `outline` plans the Answer.
5. `writer` drafts it, streaming output to the page.
6. `reviewer` checks the body against the checklist and runs a second pass if the draft is more than 10% over budget. The Quiz and FAQ are fact-checked separately.
7. `link-guard` replaces any unverified URL with its anchor text.
8. `seo-meta` and `images` run in parallel.
9. `assemble` builds the preview HTML and copy-ready Markdown.

**Markdown format** (`lib/edpressoAssemble.ts`, safe on client and server): the saved Markdown is the single source of truth.

- The writer emits code and tables inside `[code]` and `[table]` tags, so line references match the code.
- Each `[image]` tag gets a `[Url]` once its image is generated.
- Widgets the tool cannot build (Quiz, FAQ, Callout, Slides, LaTeX) are `[[Quiz widget]] … [[/Quiz widget]]`-style placeholders that carry the full content.
- Keyword popups use `#key# term: definition #key#`.

Preview HTML, copy-ready Markdown and word counts are all derived from the saved Markdown, so edits on `/edpresso/[id]` stay consistent.

## Project layout

```
app/
  edpresso/                 List, new-Shot form, and detail pages
  graph/  prompts/          Pipeline graph and prompt editor
  api/edpresso/             POST start run (SSE) · GET list
  api/edpresso/[id]/        GET / PATCH / DELETE · stream (re-attach SSE) · cancel
  api/images/[...filepath]  Serves generated images from data/images
  api/prompts/              Prompt registry read / save / reset / rollback
lib/
  edpressoPipeline.ts       Pipeline stages, Answer types, event types
  edpressoPrompts.ts        Prompt templates
  edpressoPromptsRegistry.ts  Wraps prompts so UI edits apply without code changes
  edpressoAssemble.ts       Markdown → preview HTML, copy-ready Markdown, word counts
  runManager.ts             Background run registry; runs survive closed tabs
  storage.ts                One JSON file per run under data/blogs/
  promptStore.ts            File-backed, versioned prompt overrides under data/prompts/
  ai.ts  imageGen.ts        OpenAI text, search and image helpers
  pipelineGraph.ts          Static graph rendered on /graph
```

Runtime data (Shot records, generated images, prompt overrides) is written to `data/`, which is git-ignored.
