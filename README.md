# EdpressoShots

Generate Edpresso Shots (Educative Answers) optimized for SEO, GEO, AEO and AIO.

An internal Next.js tool that runs a multi-stage AI pipeline to produce a short, search-first Educative Answer. Stage output streams in real time, links are HTTP-verified, and images are generated in parallel. Each finished Shot is created on educative.io as an unpublished draft Answer, where a human reviewer checks and publishes it. Copy-ready Markdown is still available as a fallback.

## Run locally

```bash
git clone https://github.com/aadilziakhan-educative/EdpressoShots.git
cd EdpressoShots
cp .env.example .env.local   # add your OpenAI API key and Educative cookie
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
| `EDUCATIVE_FLASK_AUTH` | No | `flask-auth` cookie of an educative.io account that can author Answers. When set, each Shot is created as a draft Answer. When empty, Shots stay local |

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

**Inputs:** a title or search query, target keywords, FAQs (one per line), an optional language, an Answer type (or auto-detect), up to 3 optional competitor URLs, up to 2 optional Educative course links, and an optional editor link of an existing Answer to replace (for example `https://www.educative.io/editor/answereditor/6241014612361216`).

**Answer types and body word budgets** (`ANSWER_TYPES`):

| Answer type | Body word budget | Images |
|---|---|---|
| Error | under 250 | 1 |
| Function or API | under 500 | 1 |
| How-to with multiple methods | 500 to 1,000 | 2 |
| Concept | up to 1,000 | 2 |
| Technology | up to 1,000 | 2 |

Each type has its own section structure, which is passed into the prompts as a string. Body word counts exclude code, tables, images, widget placeholders and FAQ answers.

**Stages:**

1. `classify` picks the Answer type and language.
2. `competitor-research` and `link-discovery` run web searches in parallel.
3. `link-verify` sends an HTTP GET to every candidate link, keeps 2xx responses and drops competitor domains.
4. `outline` plans the Answer.
5. `writer` drafts it, streaming output to the page.
6. `reviewer` checks the body against the checklist and runs a second pass if the draft is more than 10% over budget. The Quiz and FAQ are fact-checked separately.
7. `link-guard` replaces any unverified URL with its anchor text.
   `course-links` runs when course links were given. Each course link must appear exactly once in the body, on a fact, keyword, concept or example the sentence already has. It must never name the course or use advert wording such as "this course", "to learn more" or "covered in". Advert sentences are deleted, and duplicate links or links in headings, quotes, popups, the Quiz or the FAQ are removed. If a course is left unlinked, the model picks a numbered candidate sentence and the anchor words, and code inserts the link without changing any other text. The **Links** tab shows where each course link landed.
8. `seo-meta` and `images` run in parallel. As in the blog pipeline, images are required: the outline and writer must include the type's image count. If the draft still has fewer, `image-plan` adds the missing image tags to the sections that benefit most before generation.
9. `assemble` builds the preview HTML and copy-ready Markdown.
10. `educative` creates the Answer as an unpublished draft on educative.io (`lib/educative.ts`). It runs only when `EDUCATIVE_FLASK_AUTH` is set. A failure does not fail the run. Use **Send to Educative** or **Update on Educative** on the Shot page to retry or push edits to the same draft.
    When an existing Answer link was given, no new Answer is created. That Answer's whole content, title and tags are replaced by the Shot. Its published URL, canonical URL, programming and topic tags, and Docker setup are kept, so the live link doesn't change. The live page updates only when a reviewer publishes. The link and access to the Answer are checked before generation starts.

**Markdown format** (`lib/edpressoAssemble.ts`, safe on client and server): the saved Markdown is the single source of truth.

- The writer emits code and tables inside `[code]` and `[table]` tags, so line references match the code.
- Each `[image]` tag gets a `[Url]` once its image is generated.
- Image alt text: Educative's Image widget has no separate alt field. The published page uses the caption as the image's `alt` and `title`. So every caption is written as alt text: 8–20 words and at most 125 characters, saying what the image shows. A missing or generic caption ("Diagram", "Figure 2") is rebuilt from the image description (`imageAltText` in `lib/edpressoAssemble.ts`).
- Other widgets are `[[Quiz widget]] … [[/Quiz widget]]`-style placeholders that carry the full content: Quiz, FAQ, Pause and think (an open question with a hidden answer), Callout (the opening hook), Terminal (commands to try), Slides and LaTeX. When a Shot is sent to Educative, FAQ becomes an FAQ Accordion widget, Quiz a Quiz widget, and Pause and think a StructuredQuiz widget. The rest stay as labelled placeholders for the reviewer.
- Keyword popups use `#key# term: definition #key#`.

Preview HTML, copy-ready Markdown and word counts are all derived from the saved Markdown, so edits on `/edpresso/[id]` stay consistent.

## Project layout

```
app/
  edpresso/                 List, new-Shot form, and detail pages
  graph/  prompts/          Pipeline graph and prompt editor
  api/edpresso/             POST start run (SSE) · GET list
  api/edpresso/[id]/        GET / PATCH / DELETE · stream (re-attach SSE) · cancel · educative (create or update draft)
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
  educative.ts              Markdown → Educative editor blocks; creates the draft Answer and uploads images
  pipelineGraph.ts          Static graph rendered on /graph
```

Runtime data (Shot records, generated images, prompt overrides) is written to `data/`, which is git-ignored.
