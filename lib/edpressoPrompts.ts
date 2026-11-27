// Prompt templates for the Edpresso Shots (Educative Answers) pipeline.
//
// Every function here is a pure template: it only interpolates `args.*` values, with no branching.
// That is what lets lib/promptStore.ts capture each one as an editable `{{var}}` template for the
// /prompts UI. Anything conditional (Answer type structure, word budget, language) is computed in
// lib/edpressoPipeline.ts and passed in as a ready-made string.
//
// Pipeline order: classify → competitor research ‖ link discovery → outline → writer → reviewer → SEO meta.

// ---------------------------------------------------------------------------
// 1) Classify — pick the Answer type and programming language
// ---------------------------------------------------------------------------
export function edpressoClassifyPrompt(args: {
  title: string;
  keywords: string;
  requestedLanguage: string;
}): string {
  return `You are classifying a requested Educative Answer (a short, search-first technical article that answers exactly one question).

# Input
- Title or search query: ${args.title}
- Target keywords: ${args.keywords}
- Language requested by the author (may be empty): ${args.requestedLanguage}

# Answer types (pick exactly one)
- "error": The title names a specific error message, exception, or failure and the reader wants the cause and the fix. Example: "The 'fatal: refusing to merge unrelated histories' Git error".
- "function": The title is about ONE function, method, operator, or API and how to call it. Example: "What is is_nan() in PHP?".
- "howto": The title asks how to accomplish a task that has several valid methods, and the Answer should walk through each method. Example: "How to generate random numbers in Java", "How to concatenate strings in Python".
- "concept": The title is about a concept, algorithm, data structure, or technique. Example: "What is geohash?", "Differentiate between a substring, a subsequence, and a subset".
- "technology": The title is about a language, framework, library, tool, or platform as a whole. Example: "What is Elixir?".

# Language rules
- If the author requested a language, use it exactly.
- Otherwise, if the title names a language or technology with its own syntax (Java, Python, Git, SQL, PHP…), use that.
- Otherwise, if code would genuinely help the reader, choose the most common language for the topic (default to "python").
- If the topic does not need code at all, use "none".

# Output
Return ONLY a JSON object:
{
  "answerType": "error" | "function" | "howto" | "concept" | "technology",
  "language": "<lowercase language name, or none>",
  "primaryKeyword": "<the single search phrase this Answer must rank for, written as natural English with correct casing, e.g. \"is_nan() in PHP\" rather than \"is_nan php\">",
  "tags": ["<3–5 lowercase, hyphenated topic tags readers browse by, most specific first, e.g. \"kmeans-clustering\", \"r\", \"clustering\", \"machine-learning\">"],
  "commandLine": true | false,
  "scope": "narrow" | "broad",
  "reason": "<one sentence explaining the choice>"
}

- commandLine: true only when the subject is something readers do in a terminal: a shell command, a command-line tool, Git, a package manager, Docker, or an installation or setup task. False for a function, library, algorithm, or language feature that runs as a program, even if it has optional setup.
- scope: "narrow" when the title is about one parameter, option, flag, argument, error, or one specific behavior of a function (for example "K-means clustering in R using the nstart parameter", "What does keepdims do in NumPy sum?"); "broad" when it is about a whole function, task, concept, or technology.`;
}

// ---------------------------------------------------------------------------
// 2a) Competitor research + People also ask (web search)
// ---------------------------------------------------------------------------
export function edpressoCompetitorResearchPrompt(args: {
  title: string;
  keywords: string;
  language: string;
  answerTypeLabel: string;
  competitorUrls: string;
}): string {
  return `You are an SEO researcher preparing a brief for an Educative Answer. Search the web as a user in the United States would, using Google-style queries.

# Answer to be written
- Title or search query: ${args.title}
- Answer type: ${args.answerTypeLabel}
- Target keywords: ${args.keywords}
- Programming language: ${args.language}

# Competitor pages the author wants analyzed (may be empty)
${args.competitorUrls}

# Tasks
1. Search for the title and the main keywords. Identify the top-ranking pages (plus every competitor URL listed above).
2. For those pages, record what they cover: their section headings, the methods or subtopics they include, and any FAQ questions they answer.
3. Find the exact questions that appear in Google's "People also ask" and in related searches for this topic.
4. Identify gaps: useful subtopics, edge cases, version notes, or pitfalls that the top pages miss or explain poorly.
5. Collect authority material, each with its source URL:
   - Verifiable facts and statistics (dates, version numbers, complexity figures, benchmarks, adoption numbers).
   - Official documentation pages for the functions, APIs, or tools involved.
   - Real quotes from recognized experts (language creators, authors of well-known books, official docs), with the person's name and where it was said. Never invent or paraphrase a quote into quotation marks.
   - Relevant history: who created the language, library, tool, or function, and when (one line each).
   - What the name stands for when it is an acronym or abbreviation (for example "grepl" = "grep logical", "cURL" = "Client for URL").
   - Hook material: a surprising, verifiable fact or statistic about the topic, and a concrete real-world scenario in which a developer runs into the exact problem this Answer solves.
   - Well-known companies or products that use the technology, when relevant.
6. Collect related long-tail and semantically related (LSI) keywords you observed in titles, headings, autocomplete, and related searches. Include the different ways people phrase this exact question (for example "nstart in kmeans R", "what does nstart = 25 mean", "kmeans nstart vs iter.max").
7. Find documented behaviors that surprise users: arguments that are ignored in some cases (for example, kmeans() ignores nstart when centers is a matrix), defaults, and limits. List them under Common errors and warnings too, with the official source.
8. Search explicitly for "<function or tool> warning" and "<function or tool> error" (for example "kmeans warning", "kmeans did not converge"), then find the errors, warnings, and surprising results people search for with this topic (Stack Overflow questions, GitHub issues, forum threads, "why does … give different results"), with the exact message text and the fix. List the 1–5 most searched.

# Output (Markdown, no preamble)
## Top-ranking coverage
- <page title> (<URL>): <headings and subtopics covered, one line>

## People also ask
- <exact question>

## Gaps to exploit
- <gap>

## Authority material
- Fact: <fact> — Source: <URL>
- Quote: "<exact quote>" — <person>, <role> — Source: <URL>
- History: <fact> — Source: <URL>
- Name: <what the name stands for> — Source: <URL>
- Hook fact: <surprising fact or statistic> — Source: <URL>
- Hook scenario: <a concrete situation where a developer needs this>
- Official docs: <page title> — <URL>

## Related keywords
- <keyword>

## Common errors and warnings
- "<exact error or warning text, or the surprising result>" — Cause: <cause> — Fix: <fix> — Source: <URL>

Rules: Report only what you actually found. If you are not sure a quote is exact, leave it out. A quote's Source must be the page where those exact words appear, because each quote is checked against its source page and dropped if the words are not found there. Every URL must be one you actually visited or saw in search results.`;
}

// ---------------------------------------------------------------------------
// 2b) Link discovery — candidate internal (Educative / how.dev) and official external links
// ---------------------------------------------------------------------------
export function edpressoLinkDiscoveryPrompt(args: {
  title: string;
  keywords: string;
  language: string;
}): string {
  return `You are building the internal-linking plan for a new Educative Answer. Find REAL, existing pages to link to. Search the web; do not guess URLs.

# Answer
- Title: ${args.title}
- Keywords: ${args.keywords}
- Programming language: ${args.language}

# What to find
1. Internal pages (8–15), searching with queries such as:
   - site:educative.io/answers <related term>
   - site:how.dev/answers <related term>
   - site:educative.io/blog <related term>
   - site:educative.io/courses <related term>
   - site:educative.io/path <related term>
   Prefer pages that explain prerequisite terms, sibling functions or methods, related concepts, and one or two course or path pages a reader of this Answer would take next.
2. Official external references (1–5): always include the official documentation page for the main function, command, or API in the title (for an R function, its reference page such as stat.ethz.ch/R-manual or search.r-project.org; for Python, docs.python.org or the library's docs), plus official language or framework documentation (prefer stable, version-agnostic URLs such as docs.python.org/3/… over pre-release or version-pinned pages), standards bodies (RFCs, ECMA, ISO), the tool's own website, or peer-reviewed or highly authoritative sources. Never include tutorial sites or e-learning competitors (for example GeeksforGeeks, W3Schools, Programiz, TutorialsPoint, Javatpoint, freeCodeCamp, Baeldung, Real Python, Medium, dev.to, Udemy, Coursera, Codecademy, DataCamp) or Q&A forums.

# Output
Return ONLY a JSON object:
{
  "internal": [ { "url": "<full https URL>", "title": "<page title>", "topic": "<the term or concept this page explains>" } ],
  "external": [ { "url": "<full https URL>", "title": "<page title>", "topic": "<what it is the authority for>" } ]
}

Every URL must come from your search results. Every link will be checked with an HTTP request and dropped if it does not load, so do not invent any.`;
}

// ---------------------------------------------------------------------------
// 3) Outline — structure, word budget, FAQs, quiz plan
// ---------------------------------------------------------------------------
export function edpressoOutlinePrompt(args: {
  title: string;
  answerTypeLabel: string;
  wordBudget: string;
  typeStructure: string;
  language: string;
  keywords: string;
  userFaqs: string;
  research: string;
  verifiedLinks: string;
  imageCount: string;
  primaryKeyword: string;
  faqCandidates: string;
  faqTarget: string;
}): string {
  return `You are the lead editor for Educative Answers. Plan the structure of a new Answer. The Answer must rank on Google, win featured snippets, and be cited by generative engines (ChatGPT, Gemini, Claude, Perplexity), while teaching the topic well.

# Inputs
- Title: ${args.title}
- Answer type: ${args.answerTypeLabel}
- Body word budget: ${args.wordBudget}
- Programming language: ${args.language}
- Target keywords (search queries people type; cover their meaning, use the exact wording only where it reads as natural English, and never put a keyword in backticks unless it is code): ${args.keywords}
- Primary keyword (exact phrase): ${args.primaryKeyword}
- FAQs the author requires (already checked for topic; keep every one, copied word for word, including any misspelling):
${args.userFaqs}
- More FAQ candidates, most relevant first (from People also ask, word for word; already checked for topic). Copy any you use exactly as written, including spelling and capitalization: they must match Google's People also ask.
${args.faqCandidates}

# Required structure for this Answer type
${args.typeStructure}

# Research brief (competitor coverage, People also ask, gaps, authority material)
${args.research}

# Verified links available (only these may be linked)
${args.verifiedLinks}

# Planning rules
- Scope: answer the title's question completely and nothing more. Match the length to the topic; shorter is better when nothing is lost.
- Keep the body within the word budget. Code, tables, image descriptions, widget placeholders, and FAQ answers do not count toward it.
- Order points logically: most important first, related points together, prerequisites before what depends on them.
- Cover the gaps from the research brief when they fit the scope.
- Every heading must be meaningful on its own. Numbered headings use the form "Method 1: <what it does>" or "1. <Action> using <thing>".
- Keywords: the exact primary keyword appears only three times in the whole Answer: the title, the first paragraph, and one "##" heading. Everywhere else (other headings, key takeaways, captions, table titles, body text) use the other ways people phrase the question, from the related keywords in the research, or plain descriptive wording. Plan which heading carries the exact phrase. That heading must read as something people search; never force the phrase into a template such as "What is <phrase>?" when the phrase is a task or a "using …" phrase ("What is K-means clustering in R using the nstart parameter?" is wrong). If the exact phrase can't sit naturally in a heading, leave exactKeywordHeading empty and keep the phrase in the first paragraph only. Other headings use the questions people actually ask ("What does nstart do in kmeans()?", "How many starts should you use?").
- Direct answer (required): plan the Answer's first sentence or two (at most 50 words): a complete, standalone answer to the title's question that Google can quote as a featured snippet, including the practical recommendation (for example "nstart sets how many random sets of starting centers kmeans() tries; R keeps the run with the lowest tot.withinss. Use nstart = 25 or more."). It comes before the hook.
- Common errors and warnings: cover the 1–3 most searched ones from the research (exact message text, cause, fix) in the body (a Note, a "Points to remember" bullet, or a section), not only in the Quiz or FAQ. Rank them by how often people hit them in normal use: a warning that the default settings trigger (for example kmeans()'s "did not converge in 10 iterations" from the default iter.max) comes before rare edge cases (internal error codes such as ifault values).
- mustCover (required): the 3–7 facts a searcher must find in the body, each one sentence: the default value, recommended values, documented cases where the setting is ignored or behaves differently, the most commonly hit warning or error with its exact text and fix, the key trade-off, and how it differs from the related setting people most often compare it with or confuse it with (for example nstart vs iter.max), when the research shows one. Each is checked after writing and added if missing.
- Edge cases and errors must be about this Answer's subject (the parameter or function in the title): a generic error that happens regardless of it (for example "more cluster centers than distinct data points", which also fails with nstart = 1) doesn't qualify. Prefer the documented cases where the subject is ignored or behaves differently.
- Playgrounds: every runnable program is a playground readers can edit and run (running one requires signing in), so when the topic has code, plan 2–3 short programs in different sections: the basic usage first, then one for the most searched warning or error and its fix, and one for a documented edge case (for example, showing that a setting is ignored). Each program must show something different; never two programs for the same point.
- Parallel items get numbered subheadings: when a section covers two or more parallel items (warnings, errors, edge cases, steps, methods, scenarios, tips), give each its own "###" subheading, numbered with a label that fits the content and named by what it is ("### Issue 1: \"did not converge in 10 iterations\" warning", "### Issue 2: nstart is ignored when centers is a matrix", "### Step 1: …", "### Method 1: …", "### Scenario 1: …"). Use the exact message text in the subheading when the item is an error or warning. Each subsection opens with one sentence that answers it directly (the cause and the fix, or what the step does). Google lists these subheadings in AI overviews and list snippets. A section with a single item needs no subheading. Plan these subheadings in the outline's sections (level 3).
- No repetition: each idea is explained once. Don't plan separate sections for why it matters, the problem it solves, and how it changes the result when they make the same point; merge them. A walkthrough appears once: as a Slides widget or as a numbered list, never both for the same steps.
- Use cases: mention only real-world uses that connect to the running example or to the problem the Answer solves, in a sentence or two; never a generic list of fields (gene expression, image compression, sensor data…). Leave use cases out when nothing specific applies.
- Hook (required): plan one opening hook that makes the reader stop. Prefer, in order: (1) a real quote from a recognized person, from the research, that is directly about this topic; (2) a surprising, sourced fact or statistic; (3) a concrete real-world scenario in which the reader hits this exact problem (for example "filtering a summer sale so no winter products appear"). Never invent a quote or attribute one loosely; never use a generic quote that would fit any article. A quote is used only if its sourceUrl is the page where those exact words appear: every quote is checked against its source page, and an unconfirmed quote is replaced by the fallbackHook. Plan the bridge: one sentence that ties the hook to the topic. Always plan a fallbackHook too: a sourced fact or a concrete scenario (never a quote). The hook must be surprising or concrete; never a plain restatement of a default value or of a key takeaway.
- Optionally plan one more quote (sectionQuote) for a section break, only if the research has a real, relevant one; it must be followed by a sentence that connects it to that section.
- Choose the other authority elements from the research brief: facts or statistics with sources, the creator and year of the language, library, tool, or function (one clause), what the name stands for, official docs. Prefer these over anecdotes.
- Plan one running example (concrete values or a small dataset) and reuse it across every method or step, so readers compare techniques on the same input. For data topics, prefer a real built-in or well-known dataset (for example R's mtcars or PlantGrowth, seaborn's tips) over made-up values. The example must make the Answer's point visible when the code runs: every program is executed, so if the Answer shows that a setting changes the result, pick data and parameters where it really does (for example, iris with centers = 3 is so easy that every k-means start finds the same answer; centers = 5 or overlapping simulated clusters show different local minima).
- Plan one "pause and think" question (pauseQuestion): a short open question a reader is likely to wonder about at that point (an edge case, a common confusion, or a likely follow-up search), with a 1–3 sentence answer, placed right after the section that raises it. It must not repeat an FAQ. Skip it only for error Answers under 150 planned words.
- Images: plan exactly ${args.imageCount}. Put the "image" element on the section(s) where a picture teaches the most (a step-by-step walkthrough, an architecture, a data layout, a before/after, or how a fix changes the state). Never decorative, and at most one image per section.
- FAQs: keep every author FAQ word for word, then add questions from the candidates list, in its order (most relevant first), that the body does not already answer and that are not duplicates of an author FAQ. ${args.faqTarget} Every added candidate must be about this Answer's exact question, not the broader field. Author FAQs are always included, even broad ones; answer those accurately and briefly, tying the answer back to this Answer's topic where it fits naturally. When the research lists common errors or warnings, an FAQ about the most searched one is welcome.

# Output
Return ONLY a JSON object:
{
  "primaryKeyword": "<main search phrase>",
  "directAnswer": "<the first sentence or two of the Answer, at most 50 words>",
  "exactKeywordHeading": "<the one \\"##\\" heading that contains the exact primary keyword, or empty when it can't read naturally>",
  "mustCover": ["<fact a searcher must find in the body>", "..."],
  "hook": { "type": "quote" | "fact" | "scenario", "text": "<exact quote, fact, or scenario>", "attribution": "<person and role for a quote, otherwise empty>", "sourceUrl": "<URL or empty>", "bridge": "<sentence that ties the hook to the topic>" },
  "fallbackHook": { "type": "fact" | "scenario", "text": "<sourced fact or concrete scenario>", "sourceUrl": "<URL or empty>", "bridge": "<sentence that ties it to the topic>" },
  "commonErrors": [ { "message": "<exact error or warning text>", "where": "<heading of the section, or FAQ>" } ],
  "sectionQuote": { "text": "<exact quote>", "attribution": "<person and role>", "sourceUrl": "<URL>", "afterHeading": "<heading of the section it opens>" } | null,
  "runningExample": "<the concrete values or dataset reused across methods or steps>",
  "pauseQuestion": { "question": "<open question>", "answer": "<1–3 sentence answer>", "afterHeading": "<heading of the section that raises it>" } | null,
  "keyTakeaways": ["<planned takeaway>", "..."],
  "sections": [
    {
      "heading": "<heading text>",
      "level": 2 | 3,
      "purpose": "<what this section must answer, answer-first>",
      "elements": ["paragraph" | "steps" | "code" | "table" | "image" | "slides" | "note" | "latex"],
      "keywords": ["<keywords to use here>"],
      "links": ["<verified URL to use here>"],
      "words": <planned prose words>
    }
  ],
  "includeQuiz": true | false,
  "faqs": [ { "question": "<question worded as searched>", "source": "author" | "people-also-ask" } ],
  "plannedBodyWords": <sum of section words>
}`;
}

// ---------------------------------------------------------------------------
// 4) Writer — full Answer in Markdown with widget tags and placeholders
// ---------------------------------------------------------------------------
export function edpressoWriterPrompt(args: {
  title: string;
  answerTypeLabel: string;
  wordBudget: string;
  typeStructure: string;
  language: string;
  keywords: string;
  outline: string;
  research: string;
  verifiedLinks: string;
  imageCount: string;
  primaryKeyword: string;
  terminalRule: string;
  closingRule: string;
}): string {
  return `You are a senior technical writer for Educative Answers. Write the complete Answer described below.

# Inputs
- Title (already set separately; do NOT repeat it as a heading): ${args.title}
- Answer type: ${args.answerTypeLabel}
- Body word budget: ${args.wordBudget}
- Programming language for code: ${args.language}
- Target keywords (search queries people type; cover their meaning, use the exact wording only where it reads as natural English, and never put a keyword in backticks unless it is code): ${args.keywords}
- Primary keyword (exact phrase): ${args.primaryKeyword}

# Structure for this Answer type
${args.typeStructure}

# Approved outline (follow its order, headings, elements, FAQs, and quiz decision)
${args.outline}

# Research brief (facts, quotes, and sources you may use)
${args.research}

# Verified links (the ONLY URLs you may use)
${args.verifiedLinks}

---

# Audience and voice
- The reader typed this question into a search engine or asked an AI assistant. They want a correct, complete answer quickly, then depth if they keep reading.
- Tone: authoritative, neutral, textbook-like, positive. Write "experts recommend…", not "some people think…". Prefer "more comfortable" over "less painful", and "might not be possible" over "impossible" when that is the accurate claim.
- No persona, no first-person stories, no anecdotes. Build trust through authority instead: an expert quote with the person's name, facts and statistics with sources, history, official documentation, and companies or products that use the technology.
- Use "we" for walking through examples ("Let's see…", "we create…") as Educative Answers do.

# Writing rules
- Short, easy sentences. Each paragraph has one theme and opens with its key point. Split long paragraphs; merge stray one-liners.
- No vague claims ("the best", "better") without saying in what way (faster, less memory, proven, cheaper). Name the scenarios when something fails. No hyperbole ("gazillion", "blazing fast").
- No flowery language, no clichés, no filler. Every element must be necessary. Anything you mention is a promise; cover it.
- Say each point once. The key takeaways, the comparison table, and the closing must not restate each other: the table compares, the closing adds a decision rule or a next step. Don't write consecutive sections that make the same point in different words (why it matters / the problem it solves / how it changes the result): merge them.
- State each fact at most twice in the whole Answer (for example once in the body and once in a takeaway or FAQ); the hook never repeats a takeaway.
- Troubleshooting advice ("if X seems to do nothing, check Y") must name only real causes; check each one against how the function actually works.
- Never invent example numbers or outputs ("Suppose one fit returns 22.6…"). Every program is run, so quote real values from what the programs print, or describe the result without numbers.
- When you recommend a specific value (nstart = 25), say why in one sentence: the source that recommends it or the reasoning (for example, the chance that all starts miss the best solution shrinks quickly with more starts, and 25 is the common textbook choice), and cite it if the research has a source.
- Recommendations (defaults, ranges, thresholds) are stated identically everywhere: the direct answer, takeaways, body, Quiz, and FAQ (never "20 to 50" in one place and "10 to 50" in another).
- Captions and image descriptions must be true of the code and data actually used (don't call 4-dimensional data "2D").
- State documented behavior plainly, as the documentation does ("nstart is ignored when centers is a matrix"), never a vaguer paraphrase ("not used in the usual way").
- Never leave template placeholders such as "role", "<name>", or "TBD" in the text; leave out what you don't know (a quote attribution is just the name and source if the role is unknown).
- No section exists only to hold links or name an implementation ("Popular implementation in R", "For background, see …"); put a useful link on words a real sentence needs.
- Every fact in the outline's mustCover list appears in the body prose (not only in the Quiz or FAQ).
- Real-world uses must connect to the running example or the problem the Answer solves; never a generic list of fields. Leave them out when nothing specific applies.
- Never use a term before it is explained, linked, or given a keyword popup.
- Ask and answer what, why, and how. Preempt the reader's next question (if you say one approach is faster, say why).
- When listing items, order them logically: most important first, related items together.
- Avoid repeating the same word in consecutive sentences; vary transitions ("First", "Next", "After that", "Finally").
- Be technically exact. Include version numbers, deprecation notes, and complexity where relevant. Never fabricate a fact, a statistic, a quote, or a source.

# Answer engine and featured snippet rules
- The first one or two sentences under every heading must directly answer that heading's question on their own.
- Keep each section self-contained: repeat the subject's name instead of "it" or "as mentioned above" when a section starts.
- Include a "What is <subject>?" style section (or "What causes <error>?" for errors) whose first paragraph is a 40–60 word dictionary-style definition with no opinion.
- Put anything comparable (options, methods, versions, trade-offs) in a table with a title so it can become a featured table.
- Use numbered headings ("Method 1: …", "Step 1: …", "1. …") for multi-step or multi-method content; each heading must also say what the step or method is.
- The exact primary keyword appears only in the first paragraph and in the one "##" heading the outline names (exactKeywordHeading; if it is empty, only in the first paragraph), plus the title, which is set separately. Headings are phrased the way people search; never "What is <a task or 'using …' phrase>?", and never a question that wraps the keyword around itself ("What does nstart do in K-means clustering in R using the nstart parameter?"). If the exact phrase doesn't fit a heading naturally, put it in the first paragraph only. Nowhere else: not in other headings, the key takeaways, code captions, image captions, table titles, or body sentences. There, use the other ways people phrase the question (from the related keywords) or plain descriptive words. Code checks this and rewrites any extra use.
- Never bold a keyword to highlight it; bold only labels and genuinely important terms.
- Target keywords are search phrases, not strings to paste. Reorder, inflect, and capitalize them so every sentence stays grammatical: write "how to reverse a list in Python" or "the Python \`reversed()\` function", never "\`reversed()\` python for backward iteration" or "this modulenotfounderror appears". Search engines match the meaning; broken grammar costs trust. If a keyword cannot be used naturally, leave it out.

# Links
- Link ONLY to URLs from the verified links list. Never write any other URL.
- Turn the relevant words into the link anchor; never write "click here", "this Answer", or "see this".
- Prefer internal Educative and how.dev links. Use official external links only as sources for facts, quotes, or documentation.
- If the verified list is empty, write no links.
- Put a link only on a sentence the Answer needs anyway. Never point at a link ("see …", "refer to …", "for the parent idea, see …", "for more, read …"); the anchor is part of a sentence that teaches something.
- No heading repeats the title. Never write a sentence whose job is to hold a link ("If R basics are familiar…", "Experts recommend…", "Writing repeatable analysis is part of R development").
- Link verified Educative course or path pages like any other page: on words the sentence needs anyway. Never point the reader to a course or path ("this course", "to learn more", "check out", "take a look", "enroll"), and never end the Answer with such a pointer.

# Keyword popups
- For 2–5 technical terms a newcomer may not know (jargon, acronyms, named algorithms or tools) that need only a one-line explanation, use Educative's inline keyword popup syntax exactly: #key# <term>: <one-sentence definition> #key#
- Never turn a target keyword, a command, or a common word into a popup just to repeat it. The popup term must read naturally as part of the sentence.
- Readers see only the term; the definition appears on hover. So the sentence must read correctly with the popup replaced by its term alone, and any punctuation that ends or continues the sentence goes AFTER the closing #key# ("…returns a reverse #key# iterator: An object that yields values one at a time. #key#. Use it when…").
- Example: "Random numbers are used to generate #key# OTP: One-time password, a code valid for a single login or transaction. #key# codes."
- Define each term once, at first use. Never make a separate glossary.
- Popups work only in body paragraphs, list items, and the key takeaways (Educative renders them in Markdown text blocks only). Never put one in a heading, the Callout hook, a code or image caption, a table, a Pause and think widget, the Quiz, or the FAQ: there it would show as raw "#key#" text.
- Exact form: "#key# term: definition #key#" with one space after the opening marker and before the closing one, a term with no colon, and a definition on one line with no "#" or "|".

# Output format (pure Markdown, no preamble, no title heading)

1. Open with the outline's directAnswer as the very first paragraph: one or two sentences (at most 50 words) that fully answer the title's question on their own, including the practical recommendation, so Google can quote it as a featured snippet. It uses the exact primary keyword only if the sentence reads naturally with it; otherwise its core terms ("In R, nstart tells kmeans() …", never "In R, K-means clustering in R using the nstart parameter means …"). Never bold it. Nothing comes before it: no quote, no heading, no widget.

1b. Then the outline's hook. For a quote or a fact, use a Callout widget placeholder:
[[Callout widget]]
"<exact quote>" — <Name>, <role>
[[/Callout widget]]
(for a fact: the fact itself, with no attribution line). Use only the outline's hook quote, copied exactly; never another quote. For a scenario hook, there is no Callout: the paragraph after the direct answer opens with the scenario. In every case, one sentence after the hook connects it to the topic (the outline's bridge), so the hook leads into the Answer instead of standing alone.

2. Then the key takeaways blockquote. Each bullet must be useful on its own (not a table of contents) and specific to this topic; use bold labels where they help. Never restate the parameter list or say something generic such as "the best method depends on your needs":
> **Key takeaways:**
> - **<Label>:** <takeaway>
> - <takeaway>

3. Then the body. Use "##" for sections and "###" for subsections, in sentence case. Do not use "#".
   Parallel items get numbered subheadings: when a section covers two or more parallel items (warnings, errors, edge cases, steps, methods, scenarios, tips), give each its own "###" subheading, numbered with a label that fits the content and named by what it is ("### Issue 1: \"did not converge in 10 iterations\" warning", "### Issue 2: nstart is ignored when centers is a matrix", "### Step 1: …", "### Method 1: …", "### Scenario 1: …"). Use the exact message text in the subheading when the item is an error or warning. Each subsection opens with one sentence that answers it directly (the cause and the fix, or what the step does). Google lists these subheadings in AI overviews and list snippets. A section with a single item needs no subheading.
   Never place two elements back to back: a code tag, table, image, fenced block, or any [[… widget]]. Put at least one full sentence between any two of them that tells the reader what the next element shows (a heading alone does not count).

4. Code: write the full, correct, runnable code yourself inside a code tag, in exactly this shape:
[code]
Language: <language>
Caption: <descriptive caption saying what this program shows; not the primary keyword>
\`\`\`<language>
<complete runnable program with brief comments on key lines>
\`\`\`
[/code]
   - Give the bigger picture before the code, then explain the code after it, referring to line numbers in bold ("**Lines 4–6:** …"). Line 1 is the first line of the program, as the editor numbers it. Never add line-number comments (such as "# 1", "// 2") to the code. Every variable or function you name in the text must have exactly that name in the code (for example, don't write kmeans(x_scaled, …) when the code uses x). Code numbers each program's lines and checks every reference.
   - Keep setup short so programs are easy to compare: prefer a built-in dataset or a few lines of data (under 5 setup lines). Each program runs on its own, so it repeats its setup, but never a long block.
   - The first runnable program (the basic usage) comes early: right after the short definition near the top, in the first third of the body, before longer explanations of why or how it works. Plan 2–3 programs when the topic allows (basic usage, the most searched warning or error and its fix, a documented edge case); each one shows something different.
   - Label every warning or error with the call that raised it, and print each distinct message once per call (not once overall: when two runs warn, show both).
   - Explain in the text any printed value a reader would find surprising (for example R's kmeans() reports iter = 2 even when iter.max = 1), or don't print it.
   - Simulated data has as many groups as the number of clusters (or classes, components) the program asks for, unless the point is choosing that number; otherwise a "better" result is only a different way to split the same groups.
   - Never print a hard-coded value as if the program computed it (cat("Default nstart:", 1)); read it from the API (formals(kmeans)$nstart) or don't print it.
   - Never name a variable after a built-in function (R: c, t, T, F, df, data, list, mean, sum, max, min, length, names; Python: list, dict, str, sum, max, min, id, type, input, len).
   - Put the line-by-line explanation directly under the program it explains, before any output discussion, image, or note.
   - A program that demonstrates a warning or error must catch it and print its message (R: withCallingHandlers(…, warning = function(w) { cat("Warning:", conditionMessage(w), "\\n"); invokeRestart("muffleWarning") }) or tryCatch; Python: warnings.catch_warnings(record=True) or try/except), so the run finishes cleanly: Educative marks any run that writes warnings or errors to stderr as failed.
   - Every program is run on Educative before publishing, and its real output is checked against what you write. So a program that demonstrates a behavior must make it visible in its output on the chosen data: pick data and parameters where the effect actually happens (for example, data with several local minima, so different seeds give different results, rather than data so easy that every run gives the same answer). Never claim a difference, speedup, or result the output won't show; for timing claims, use data large enough that the times differ.
   - Programs must compile and run as written and print visible output. Keep them short and focused. Use the current, supported version of the language (for example Python 3 \`print()\`).
   - Put every piece of code that can run inside a code tag, so readers can edit and run it on Educative. This includes short demonstrations: make them complete, minimal programs (imports, a main function where the language needs one, and printed output) rather than fragments. Name the key line in the sentence before the program and keep it near the top. A runnable program must really perform the operation it teaches and print the real result; never write a script that only prints or echoes the commands it describes. For tools such as Git, build a throwaway setup inside the script (for example a temporary repository plus a local bare repository as its "origin", with git user.name and user.email set) so the real commands run end to end without network access or an editor. If the operation cannot run that way, show the commands in a Terminal widget instead. A code tag must run exactly as written: no placeholders such as <sha> or <branch>, no commands that open an editor or wait for input (for example git rebase -i, vim, read), and it must create anything it uses. Use a plain fenced block only for code that cannot run on its own: a syntax or signature line, a reference list of commands, a configuration file, a command's output, or pseudo-code. Shell commands go in a Terminal widget. Use short inline code (\`like_this()\`) for names in sentences.
   - Reuse the outline's running example in every program, so only the technique changes between methods.
   - Every code caption is unique and says what that specific program shows; never leave a caption empty or copy it from another block.
   - When the output is not obvious (a surprising value, a flag that changes behavior, a difference between methods), explain after the program what it prints and why each value appears; quote the key output line inline or in a short fenced block introduced by a full sentence.
   - When methods behave differently on some input, prove it with one short program that runs both on that input and prints the difference, instead of only stating it.

5. Tables: write the table yourself, in exactly this shape:
[table]
Table title: <descriptive title saying what the table compares; not the primary keyword>
| Header | Header |
|---|---|
| cell | cell |
[/table]

6. Images: include exactly ${args.imageCount}, in the sections the outline marks with "image". Each must teach something (a step-by-step walkthrough, an architecture, a data layout, a before/after); never decorative. Place each image right after the paragraph it illustrates, in exactly this shape:
[image][Description]<2–3 sentences describing exactly what the illustration shows: the specific components, their labels, the values, and the arrows or data flow between them>[/Description][Caption]<alt text: 8–20 words, at most 125 characters, in sentence case>[/Caption][/image]
   An image can't reproduce a program's exact points, so never claim it shows "the same dataset" or exact counts unless it is a schematic of them; never put a number in an image that the programs don't print; depict the algorithm the way the documentation describes it (for example, R picks random data rows as starting centers, so starting centers sit on data points).
   The caption is also the image's alt text on Educative, so it must say what the image shows for a reader who can't see it: the subject and the key relationship or result (e.g., "Pandas groupby splitting rows by city, summing sales per group, and combining the results"). Don't start with "Image of", "Diagram showing" or "Figure"; never write a generic caption like "Diagram" or "Example"; don't use the exact primary keyword; make each caption unique.

7. Other widgets are placeholders. Write their FULL content so an editor can paste it straight into the Educative widget. Use exactly these wrappers:
[[LaTeX widget]]
<one LaTeX formula>
[[/LaTeX widget]]
   Every formula or equation goes in a LaTeX widget (for example \\arg\\min_{C} \\sum_{k=1}^{K} \\sum_{x \\in C_k} \\lVert x - \\mu_k \\rVert^2), never in a code block or plain text. One formula per widget: pure LaTeX that KaTeX can render (no $ delimiters, no prose, no Markdown); a second formula, such as a complexity, goes in its own widget. Define every symbol in the sentence after the widget, and never use one letter for two things (if i indexes points, don't also use i for iterations).
   Never write LaTeX in prose (no \\( … \\), \\[ … \\], or $ … $): text blocks show it as raw characters. Name symbols in prose with inline code in one consistent style: underscores for subscripts (\`C_k\`, \`μ_k\`, \`C_1\` to \`C_K\`), never Unicode subscripts (C₁) mixed with underscores.
   For a step-by-step walkthrough (an algorithm's dry run, how data changes step by step), use a Slides widget instead of a numbered list of the same steps (never both). Every slide shows the same data (the same points and groups throughout), uses only numbers the programs print (or none), and never says it uses the program's dataset unless every slide does: 3–6 slides, one per step, all on the same concrete example. An image is generated for each slide from its line, so each line must say exactly what that slide's picture shows: the same structure every time, with the values, labels, pointers, and what this step changes (highlighted). Introduce the widget with a sentence and explain the steps after it:
[[Slides widget]]
Slide 1: <what the slide image shows at step 1: the structure, its values and labels, what is highlighted>
Slide 2: <the same picture at step 2: what changed>
[[/Slides widget]]

   If the outline has a pauseQuestion, place it right after the section that raises it, using exactly this wrapper (the answer stays hidden until the reader clicks):
[[Pause and think widget]]
Q: <question>
A: <answer>
[[/Pause and think widget]]

   Terminal widget: ${args.terminalRule}
   When a Terminal widget is allowed, add it after the commands are explained: one sentence asking the reader to try them, then
[[Terminal widget]]
Setup:
<commands that run automatically when the terminal opens to prepare a safe practice environment, one per line: non-interactive only (no editors, no -i flags, no prompts, no sudo password), no network access, for example creating a demo repository with a few commits and a local bare repository as its origin>
Try:
<the commands the reader types, one per line, in order; each must work in the environment Setup created and must not open an editor or wait for input>
[[/Terminal widget]]
   For a command-line tool, also give its commonly used options as a table (Option | Alias | Description | Example).

8. Notes and warnings use blockquotes: "> **Note:** …". If the outline has a sectionQuote, open that section with it as a blockquote ("> "<exact quote>" — <Name>, <role>") followed by one sentence that connects it to the section.

8b. Authority details: state the creator and year in one clause only for the exact thing they created and only when the research names them (for example "NumPy, created by Travis Oliphant in 2005, …"). Never attach a language's creator to a function, module, or feature they did not personally create, and never mention the language's creator at all unless the language itself is the subject; if the research does not name the creator of the exact subject, leave the origin out. State what the name stands for when it is an abbreviation ("\`grepl()\` stands for "grep logical"").

9. End with, in this order:
   a. If the outline says includeQuiz is true: one sentence inviting the reader to check their understanding, then a Quiz widget placeholder with 3 multiple-choice questions, 4 options each:
[[Quiz widget]]
Q1. <question>
A) <option>
B) <option>
C) <option>
D) <option>
Correct answer: <letter>
Explanation: <one sentence>

Q2. …
[[/Quiz widget]]
   b. ${args.closingRule}
   c. The FAQ widget placeholder with every FAQ from the outline, in order, questions copied exactly, word for word, including spelling and capitalization (they match Google's People also ask; never reword or correct one). Each answer is 1–3 sentences, starts with the direct answer, may include a short fenced code snippet, and may link one related verified page:
[[FAQ widget]]
Q: <question exactly as planned>
A: <answer>

Q: …
A: …
[[/FAQ widget]]

# Word budget
- The body (everything except code tags, table tags, image tags, [[… widget]] placeholders, FAQ answers, and "**Line N:**" code explanations) must stay within ${args.wordBudget}. Be as brief as the topic allows.

Output only the Answer Markdown.`;
}

// ---------------------------------------------------------------------------
// 5) Reviewer — checklist audit + rewrite
// ---------------------------------------------------------------------------
export function edpressoReviewerPrompt(args: {
  title: string;
  answerTypeLabel: string;
  wordBudget: string;
  currentWordCount: string;
  typeStructure: string;
  keywords: string;
  verifiedLinks: string;
  primaryKeyword: string;
  terminalRule: string;
  closingRule: string;
  draft: string;
}): string {
  return `You are the final reviewer for Educative Answers. Audit the draft below against the checklist, fix every problem, and return the corrected Answer.

# Context
- Title: ${args.title}
- Answer type: ${args.answerTypeLabel}
- Body word budget: ${args.wordBudget}
- Current body word count (measured by code; excludes code, tables, images, widget placeholders, FAQ answers, and "**Line N:**" code explanations): ${args.currentWordCount}
- The Quiz and FAQ widgets have been removed from the draft and are re-attached after your output, at the lines that read EDPWIDGET0TOKEN, EDPWIDGET1TOKEN, and so on. Keep each of those lines exactly where it is, and do not write a Quiz or FAQ widget.
- Target keywords (search queries people type; cover their meaning, use the exact wording only where it reads as natural English, and never put a keyword in backticks unless it is code): ${args.keywords}
- Primary keyword (exact phrase): ${args.primaryKeyword}

# Required structure for this Answer type
${args.typeStructure}

# Verified links (the only URLs allowed)
${args.verifiedLinks}

# Checklist
1. Length: if the body is over budget, tighten it (cut filler, merge repeated points, shorten examples) until it fits. Never pad a draft that is under budget.
2. Structure matches the Answer type, in order. The key takeaways blockquote exists and each bullet stands on its own.
3. A "What is…" (or "What causes…") section opens with a neutral 40–60 word definition.
4. The first one or two sentences under every heading answer that heading directly. Sections are self-contained.
5. Headings are meaningful, sentence case, use "##"/"###" only, and numbered where the content is a sequence of methods or steps.
6. The exact primary keyword appears only in the first paragraph and in one "##" heading. Replace every other use (other headings, key takeaways, captions, table titles, body sentences) with another way people phrase the question or plain descriptive words. Related keywords appear naturally; no stuffing.
7. No vague claims, hyperbole, flowery language, clichés, anecdotes, or first-person stories. Tone is authoritative and positive.
8. Every technical claim is correct. Code compiles, runs, prints output, and every "**Line N:**" reference points to the right line, counting the program's first line as Line 1. Remove any line-number comments ("# 1", "// 2") from code. Every variable or function named in the text has exactly that name in the code. Fix the code or the text if they disagree. A program that demonstrates a behavior must make it visible in its output; never claim a difference or speedup the output won't show.
9. Every URL appears in the verified links list. No sentence exists only to hold a link ("If R basics are familiar…", "Experts recommend…"): delete it, or move its link onto a sentence the Answer needs anyway. No sentence points the reader to a course or path ("this course", "to learn more", "check out", "take a look", "enroll"), including in the closing section; rewrite such a sentence so its link sits on words it needs anyway, or remove the sentence. Remove any other link (keep its anchor text as plain text). Anchors are descriptive words, never "click here".
9b. No keyword is bolded just to highlight it. A creator or year appears only for the exact subject (never the language's creator in an Answer about a function or feature). Search the draft for each target keyword written word for word; wherever that exact wording is not grammatical English in its sentence, rewrite the phrase (for example "why re.sub python usage matters" → "why Python's \`re.sub()\` matters"). Target keywords appear in natural, grammatical wording with correct capitalization. Rewrite any phrase where a keyword was pasted verbatim and reads wrong (for example "\`reversed()\` python for…" → "the Python \`reversed()\` function for…").
10. Keyword popups use the exact syntax "#key# term: definition #key#", appear 2–5 times, and only explain jargon. Read each sentence with the popup replaced by its term alone; it must still be correct, with sentence punctuation after the closing #key#. Remove popups that merely repeat a target keyword or wrap a command, and fix keywords inserted with wrong casing or broken grammar.
11. Keep every [image] tag the draft has; never remove or merge images. Widget syntax is intact: [code]…[/code] with Language, Caption, and a fenced block; [table]…[/table] with "Table title:"; [image][Description]…[/Description][Caption]…[/Caption][/image]; and [[X widget]]…[[/X widget]] placeholders.
12. The Quiz token (if any) comes after a sentence inviting the reader to check their understanding; the FAQ token comes last. Closing: ${args.closingRule}
13. Lists are ordered logically (most important first). Paragraphs open with their key point. No repeated words in consecutive sentences.
14. The very first paragraph is a direct answer to the title's question in one or two sentences (at most 50 words), including the practical recommendation, before any quote, heading, or widget. The hook (a Callout quote or fact, or a scenario) comes after it, followed by a sentence that ties it to the topic. Never add or change a quote; if a quote is generic or unattributed, replace it with a sourced fact or a concrete scenario.
15. Key takeaways are specific to this topic; none restates the parameter list or says something generic.
16. Every method or step reuses the same running example; any code that can run is a complete program in a code tag (only syntax lines, configuration, output, and pseudo-code stay as plain fenced blocks; shell commands go in a Terminal widget); every code caption is unique and describes its own program; non-obvious output is explained.
16b. No two elements (code tag, table, image, fenced block, [[… widget]], or EDPWIDGET token) are back to back: at least one full sentence introducing the next element sits between them.
16c. No repetition: the key takeaways, comparison table, and closing say different things. Cut a point that repeats; the closing adds a decision rule or a next step, never a restatement.
16d. Real-world uses connect to the running example or the problem solved; delete generic lists of fields.
16e. Formulas are in a [[LaTeX widget]], one formula per widget, every symbol defined, no letter used for two things. No LaTeX in prose (\\( … \\), $ … $).
16i. Parallel items get numbered subheadings: when a section covers two or more parallel items (warnings, errors, edge cases, steps, methods, scenarios, tips), give each its own "###" subheading, numbered with a label that fits the content and named by what it is ("### Issue 1: \"did not converge in 10 iterations\" warning", "### Issue 2: nstart is ignored when centers is a matrix", "### Step 1: …", "### Method 1: …", "### Scenario 1: …"). Use the exact message text in the subheading when the item is an error or warning. Each subsection opens with one sentence that answers it directly (the cause and the fix, or what the step does). Google lists these subheadings in AI overviews and list snippets. A section with a single item needs no subheading.
16h. No fact is stated more than twice; the hook doesn't repeat a takeaway; troubleshooting tips name only real causes; no "see …" link pointers; no heading repeats the title; no bolded search phrase pasted into a sentence.
16g. The first runnable program comes in the first third of the body. No invented example numbers. Recommendations are stated identically everywhere. Captions and image descriptions are true of the code and data. No numbered list repeats the steps a Slides widget shows. Headings read the way people search (never "What is <task phrase>?").
16f. Terminal widget: ${args.terminalRule}
17. Keep every [[Pause and think widget]], [[Terminal widget]], and [[Callout widget]] intact (unless 16f says to remove a Terminal widget). A Terminal widget has a "Setup:" part (non-interactive commands that prepare the environment) and a "Try:" part (commands that work in that environment and never open an editor or wait for input). No program only echoes or prints the commands it describes; replace such a program with one that really runs them, or with the Terminal widget.

# Draft
${args.draft}

# Output
Return ONLY the corrected Answer Markdown, complete, in the same format. No comments, no change log.`;
}

// ---------------------------------------------------------------------------
// 5b) Quiz + FAQ review — fact-check answers without dropping questions
// ---------------------------------------------------------------------------
export function edpressoWidgetReviewPrompt(args: {
  title: string;
  language: string;
  keywords: string;
  verifiedLinks: string;
  answerFacts: string;
  widgets: string;
}): string {
  return `You are the technical fact-checker for the Quiz and FAQ widgets of an Educative Answer titled "${args.title}" (language: ${args.language}).

# Target keywords (search queries; use their meaning, never paste them ungrammatically or in backticks unless they are code)
${args.keywords}

# Verified links (the only URLs allowed)
${args.verifiedLinks}

# What the Answer body says (the Quiz and FAQ must agree with it)
${args.answerFacts}

# Widgets to review
${args.widgets}

# Rules
- Keep every question, in the same order, with its wording unchanged. Do not add or remove questions.
- Check every answer, option, correct-answer letter, explanation, and code snippet for technical accuracy against the official behavior of the language or tool. Fix anything wrong or unverifiable; if a claim cannot be stated accurately, replace it with a correct, simpler statement.
- FAQ answers: 1–3 sentences, the direct answer first, correct casing, natural grammar. A short fenced code snippet is allowed. Answer exactly the question asked; cut anything that drifts to another point (for example, cluster label permutation in an answer about why results repeat).
- Recommendations (defaults, ranges, thresholds) must match the Answer body word for word in substance (if the body recommends 20 to 50, the FAQ doesn't say 10 to 50).
- Quiz: exactly one correct option per question; the "Correct answer" letter must match it; distractors must be plausible but clearly wrong.
- Remove any URL that is not in the verified links list (keep its anchor text).
- Keep the exact wrapper syntax: [[Quiz widget]] … [[/Quiz widget]] and [[FAQ widget]] … [[/FAQ widget]], "Q:"/"A:" lines for FAQs, and "Q1."/"A)"/"Correct answer:"/"Explanation:" lines for the quiz.

Return ONLY the corrected widgets, in the same order, nothing else.`;
}

// ---------------------------------------------------------------------------
// 6) SEO meta — title tag and meta description
// ---------------------------------------------------------------------------
export function edpressoSeoMetaPrompt(args: {
  title: string;
  keywords: string;
  primaryKeyword: string;
  answer: string;
}): string {
  return `Write the search listing for this Educative Answer.

# Inputs
- Answer title: ${args.title}
- Primary keyword: ${args.primaryKeyword}
- Target keywords (search queries people type; cover their meaning, use the exact wording only where it reads as natural English, and never put a keyword in backticks unless it is code): ${args.keywords}

# Answer
${args.answer}

# Rules
- Use keywords in natural, grammatical wording with correct capitalization ("Learn how to reverse a list in Python", never "Learn reverse a list in python").
- metaTitle: 50–60 characters, starts with or contains the primary keyword, describes the Answer exactly, no clickbait, no brand suffix.
- metaDescription: 140–155 characters, states what the reader will learn in plain words, includes the primary keyword once, ends with a complete sentence. Do not paste the title into it (never "Learn how to fix How to fix…").
- slug: lowercase words joined by hyphens, derived from the title, no stop-word padding.

Return ONLY a JSON object:
{ "metaTitle": "<text>", "metaDescription": "<text>", "slug": "<slug>" }`;
}

// ---------------------------------------------------------------------------
// 7) Image plan — fills in images the writer or reviewer left out
// ---------------------------------------------------------------------------
export function edpressoImagePlanPrompt(args: {
  title: string;
  missingCount: string;
  headings: string;
  answer: string;
}): string {
  return `You are planning illustrations for an Educative Answer that has fewer images than required.

# Inputs
- Answer title: ${args.title}
- Images to add: ${args.missingCount}
- Section headings (pick from these exactly; sections that already have an image are excluded): ${args.headings}

# Answer
${args.answer}

# Rules
- Each image must teach something the prose explains: a step-by-step walkthrough, an architecture, a data layout, a before/after, or how a fix changes the state. Never decorative.
- Pick a different section for each image, where a picture helps the most.
- description: 2–3 sentences describing exactly what the illustration shows: the specific components, their labels, the values from the Answer, and the arrows or data flow between them.
- caption: it is also the image's alt text on Educative. 8–20 words, at most 125 characters, sentence case, saying what the image shows for a reader who can't see it (the subject and the key relationship or result). Don't start with "Image of", "Diagram showing" or "Figure"; never generic ("Diagram", "Example"); don't use the Answer's title phrase; unique per image.

Return ONLY a JSON object:
{ "images": [ { "heading": "<exact heading text from the list>", "description": "<text>", "caption": "<text>" } ] }`;
}

// ---------------------------------------------------------------------------
// 8) Course links — places a course link the Answer is missing on words it already has
// ---------------------------------------------------------------------------
export function edpressoCourseLinkPrompt(args: {
  title: string;
  tasks: string;
  sentences: string;
  feedback: string;
}): string {
  return `You are adding course links to an Educative Answer titled "${args.title}". Each link must read as an ordinary anchor on words the sentence already has, never as an advert.

# Course links to place
${args.tasks}

# Candidate sentences (from the Answer body)
${args.sentences}

# Rules
- Use the course description ("teaches: …") to choose: the anchor must name something that course teaches. When the course teaches a whole language (a general course or path), anchor it on the language or one of its core features as named in a sentence ("R's stats package", "base R", "R functions"), not on a topic-specific phrase like "random starting centroid configurations".
- Different course links get different anchor phrases.
- For each course link, give up to three options, best first: candidate sentences whose topic relates most closely to what the course teaches. Use different sentences for different courses.
- anchor: one to five consecutive plain words copied exactly from that sentence: a fact, a keyword, a concept name, or an example (for example "random starting centers", "local minimum", "reproducible analysis"). The anchor must not contain any backtick or inline code. It must be a complete noun phrase that names a concept related to what the course teaches (for an R course: an R feature, function family, data structure, or task, not a generic word such as "runtime") and reads well as a link on its own: never a fragment such as "running R's", never an anchor followed directly by inline code it modifies ("[base R] \`stats::kmeans()\`"), never ending in a possessive ("R's"), and never a verb phrase. A single word such as "R" is too short; "base R", "R functions", or "R's stats package" work. Never words inside backticks, never the course's name, never words starting with "learn", "master", or "explore", and never generic words that say nothing about the topic ("the first method", "this approach", "the example").

${args.feedback}

Return ONLY a JSON object:
{ "links": [ { "url": "<course URL>", "sentence": <candidate number>, "anchor": "<exact words from that sentence>" } ] }`;
}


// ---------------------------------------------------------------------------
// 9) Transitions — one sentence between two elements that sit back to back
// ---------------------------------------------------------------------------
export function edpressoTransitionsPrompt(args: {
  title: string;
  gaps: string;
}): string {
  return `In the Educative Answer titled "${args.title}", the elements below sit back to back with no text between them. Write one sentence for each gap that leads the reader from the first element into the second.

# Gaps
${args.gaps}

# Rules
- One sentence of 6–25 words per gap, in the Answer's voice ("we", present tense), that says what the next element shows or does (for example "Running the program below shows how the count parameter limits replacements.").
- Specific to the content of the next element; never generic filler such as "Let's look at the following."
- No links, no headings, no lists, and no mention of courses or resources.

Return ONLY a JSON object:
{ "sentences": [ { "gap": <gap number>, "text": "<sentence>" } ] }`;
}

// ---------------------------------------------------------------------------
// 10) FAQ check — keeps FAQs on this Answer's exact question and ranks People-also-ask candidates
// ---------------------------------------------------------------------------
export function edpressoFaqCheckPrompt(args: {
  title: string;
  primaryKeyword: string;
  authorFaqs: string;
  candidates: string;
}): string {
  return `You are checking FAQ questions for an Educative Answer titled "${args.title}" (primary keyword: ${args.primaryKeyword}).

# FAQs the author typed
${args.authorFaqs}

# Candidate FAQs from Google's "People also ask" and related searches
${args.candidates}

# Rules
- The author's FAQs are always kept; they are listed only so candidates don't repeat them. Judge only the candidates.
- relevance: 5 = about this exact question, 4 = a direct follow-up (a related argument, a warning it causes, why results change), 3 or less = drifts to the broader field (comparisons with other algorithms or tools, "types of …", general tutorials of the parent topic). A candidate that asks the same thing as an author FAQ or an earlier candidate, in other words, gets 1.

Return ONLY a JSON object:
{
  "candidates": [ { "n": <number>, "relevance": 1-5 } ]
}`;
}

// ---------------------------------------------------------------------------
// 11) Code check — every program was run on Educative; the text must match what it really prints
// ---------------------------------------------------------------------------
export function edpressoCodeCheckPrompt(args: {
  title: string;
  language: string;
  wordBudget: string;
  currentWordCount: string;
  report: string;
  draft: string;
}): string {
  return `You are the technical editor of an Educative Answer titled "${args.title}" (language: ${args.language}). Every program in its [code] tags was just run on Educative. Below is each program with its line numbers and the real output. Make the Answer agree with what the programs really do.

# Programs and their real output
${args.report}

# Fix, in this order
1. A program that fails (non-zero exit status, an error, or a timeout): fix the code so it runs and prints its result.
2. A program whose output does not show the effect it is there to demonstrate (for example, it compares settings but prints the same value for each, a "difference" is 0, a benchmark shows no change, or the timings are all the same): change the code so the effect is visible in the output. Use data or parameters where the effect really happens (data with several local minima, more clusters, overlapping groups, a larger input for timing), or a loop over several seeds or sizes that prints each result. For example, if a program meant to show that more random starts help prints the same tot.withinss for every nstart, switch to data where single starts get stuck (iris with centers = 5 or more, or simulated overlapping clusters) and loop over several seeds with nstart = 1 so the different results print. Change the running example everywhere it is used if needed, so every program stays on the same data. Never resolve such a mismatch by writing that the effect did not happen on this data ("the same value is printed, so iris is easy"): the Answer exists to show the effect. Correct the text instead only when the claim is false in general.
3. Text that states a printed value, a comparison, or a conclusion must match the real output above. Where you changed a program, describe only output you are sure it prints; don't quote exact numbers from a program you changed.
4. "**Line N:**" and "**Lines N–M:**" references count the program's first line as Line 1, as numbered above. Fix every reference so it points to the line it describes, and fix any problem listed under "Line-reference problems".
5. Every variable or function named in the text must have exactly that name in the code.
5a. Each [code] tag's "Caption:" line describes what that program actually does and prints (check every program, not only rewritten ones: a caption that says "empty-cluster error" on a program that prints "initial centers are not distinct" is wrong). Fix the caption and the sentences that introduce the program.
5b. Claims anywhere (the direct answer, the Callout hook, key takeaways, body, captions, and [image] descriptions) must match the real data and output: don't call data 2D when it has 4 dimensions, and don't say results are "noticeably different" when they differ in the fourth decimal place.
5bb. Explain any printed value a reader would find surprising (for example R's kmeans() reports iter = 2 even when iter.max = 1), in one sentence after the program.
5bc. The "**Line N:**" explanation sits directly under its program, before any output discussion, image, or note; move it there.
5bd. Every [image] description that shows a program's result must show what the real output shows: if the outputs are nearly identical, the image must not show one broken and one clean result. Use the same data as the program.
5c. Replace invented example numbers ("Suppose one fit returns 22.6…") with real values from the outputs above.
5d. A program's own output must not contradict itself (a count of "worse" runs that includes runs printing the same rounded value, a label that doesn't match its number). If it does, fix the code (for example, compare rounded values) and say so in the text; never leave it.
6. Never add line-number comments ("# 1", "// 2") to code.

# Keep
- The same structure, headings, widgets, and EDPWIDGET tokens (each on its own line, in place), every [code] and [image] tag, and the code tag format: [code] Language:, Caption:, a fenced block [/code].
- The body within ${args.wordBudget} (now ${args.currentWordCount} words). Change only what the fixes need.

# Answer
${args.draft}

# Output
Return ONLY the corrected Answer Markdown, complete. No comments, no change log.`;
}

// ---------------------------------------------------------------------------
// 12) Keyword variants — rewrites extra uses of the exact primary keyword
// ---------------------------------------------------------------------------
export function edpressoKeywordVariantsPrompt(args: {
  title: string;
  phrase: string;
  variants: string;
  items: string;
}): string {
  return `In the Educative Answer titled "${args.title}", the exact phrase "${args.phrase}" is used too often, which reads as keyword stuffing. Rewrite each numbered item below so it no longer contains that exact phrase.

# Other ways people phrase this question (use these where they fit, varied, never the same one twice)
${args.variants}

# Items to rewrite (headings, sentences, captions, and table titles)
${args.items}

# Rules
- Keep the meaning, the Markdown (inline code, links, and #key# popups exactly as they are), and roughly the same length. Never bold the new wording.
- The other phrasings are search queries, not text: rewrite them into grammatical English before using them ("kmeans nstart R" → "the nstart argument of kmeans() in R"). Never paste a query verbatim when it isn't a grammatical phrase.
- Use a different phrasing per item, or plain descriptive words ("the nstart argument", "multiple random starts"). Never use the exact phrase.
- A heading stays a short heading, phrased the way people search ("What does nstart do in kmeans()?", never "What is <task phrase>?"); a caption stays a caption; a sentence stays one grammatical sentence.

Return ONLY a JSON object:
{ "rewrites": [ { "n": <item number>, "text": "<rewritten item>" } ] }`;
}

// ---------------------------------------------------------------------------
// 13) Code verdict — does a program's real output show what it is there to show? If not, fix the program.
// ---------------------------------------------------------------------------
export function edpressoCodeVerdictPrompt(args: {
  title: string;
  language: string;
  context: string;
  others: string;
  program: string;
  output: string;
  attempt: string;
}): string {
  return `You are checking one program in an Educative Answer titled "${args.title}" (language: ${args.language}). The program was run on Educative; its real output is below. ${args.attempt}

# The text around the program (what it is meant to show)
${args.context}

# The other programs in this Answer (this one must show something different)
${args.others}

# Program (numbered lines)
${args.program}

# Real output
${args.output}

# Decide
- purpose: the one effect or result this program is there to demonstrate, in a sentence.
- Judge against what the text says the program confirms or shows ("we run code that confirms X"): the output must show X directly, for example by printing both cases side by side (a program that only prints cluster sizes does not confirm that nstart is ignored).
- shows: false also when simulated data has a different number of groups than the clusters requested (so a "better" result is just another split of the same groups), or when it prints a hard-coded value as if it were computed.
- shows: false also when the program names a variable after a built-in function (R: c, t, T, F, list, mean, sum, length…; Python: list, dict, str, sum, len…), when the text claims something about the output that the output doesn't show (for example "both runs warn" when only one warning prints), or when it prints a value that looks like a bug without explanation (iterations used = 2 with iter.max = 1).
- shows: false also when the program repeats another program's experiment (same data and the same comparison), or prints the same line many times (print each distinct warning once).
- shows: false also when the output contradicts itself or reads wrong (a count that doesn't match the values printed, for example "6 of 8 worse" when only 3 printed values are worse because of hidden decimals; missing spaces such as "6of8").
- shows: false when the effect is technically there but too small for a reader to notice (for example 11 of 12 runs within 0.1% of each other): a reader who runs it would conclude the setting barely matters. The difference must be obvious at a glance (several percent or more, or a clearly wrong result such as two clusters merged into one).
- shows: true only if the real output makes that effect visible to a reader: it ran without errors, and where it compares settings, inputs, or methods, the printed values actually differ the way the text says (a "difference" that prints 0, identical values for every setting, or timings that are all the same do not show it).
- problem: when shows is false, what the output fails to show and why (for example, "the data is so well separated that one start already finds the best solution").
- Never claim the effect is absent: the Answer exists to show it. Only if the purpose itself is false in general, set shows to true and explain in problem.

Return ONLY a JSON object:
{ "purpose": "<sentence>", "shows": true | false, "problem": "<what the output fails to show, or empty>" }`;
}

// ---------------------------------------------------------------------------
// 14) Code fix — rewrites one program so its real output shows its purpose
// ---------------------------------------------------------------------------
export function edpressoCodeFixPrompt(args: {
  title: string;
  language: string;
  purpose: string;
  problem: string;
  program: string;
  output: string;
  attempt: string;
}): string {
  return `Rewrite one program from an Educative Answer titled "${args.title}" (language: ${args.language}) so that, when it runs, its output clearly shows its purpose. ${args.attempt}

# Purpose
${args.purpose}

# Why the current program fails
${args.problem}

# Current program
${args.program}

# Its real output
${args.output}

# Rules
- Make the effect large and obvious, not marginal: use data where a bad choice gives a clearly wrong result (for k-means, well-separated groups placed so that an unlucky start puts two centers in one group and merges two others, giving a much higher tot.withinss), or loop over several seeds or sizes and print each result, so a reader sees a big difference at a glance.
- With a random algorithm, set the seed so runs are repeatable, and make sure the settings you compare do not end up identical. For example, to show that more random starts help k-means, run nstart = 1 over several seeds and print each tot.withinss (some runs get stuck in worse local minima), then print one nstart = 25 run that matches the best of them; iris with centers = 3 is too easy for this, centers = 5 or more on scaled iris, or overlapping simulated clusters, shows it.
- A program that demonstrates a warning or error must catch it and print its message (R: withCallingHandlers(…, warning = function(w) { cat("Warning:", conditionMessage(w), "\\n"); invokeRestart("muffleWarning") }) or tryCatch; Python: warnings.catch_warnings(record=True) or try/except), so the run finishes cleanly: Educative marks any run that writes warnings or errors to stderr as failed.
- Never print narration such as "Purpose: …" or "Goal: …"; print only labeled results.
- Label every warning with the call that raised it and print each distinct message once per call (collect them, then print the unique ones for each call); when two calls warn, both must show.
- Never name a variable after a built-in function (R: c, t, T, F, df, data, list, mean, sum, max, min, length; Python: list, dict, str, sum, max, min, id, type, input, len).
- Simulated data has as many groups as the number of clusters the program asks for (unless the point is choosing that number).
- Never print a hard-coded value as if computed; read it from the API (for example formals(kmeans)$nstart).
- Don't print values a reader would find surprising without a label that explains them (for example R reports iter = 2 even with iter.max = 1).
- The output must be consistent and readable: compare rounded values when you print rounded values, keep spaces between words and numbers, and label every number.
- Keep it short (about 10–25 lines), runnable as is in ${args.language} with only the standard library or packages the current program already uses, with clear printed labels. No line-number comments, no placeholders, nothing that waits for input.

Return ONLY the complete program, with no Markdown fence and no explanation.`;
}

// ---------------------------------------------------------------------------
// 15) Trim — cuts prose until the body fits the word budget
// ---------------------------------------------------------------------------
export function edpressoTrimPrompt(args: {
  title: string;
  wordBudget: string;
  currentWordCount: string;
  cut: string;
  primaryKeyword: string;
  draft: string;
}): string {
  return `The Educative Answer titled "${args.title}" is over its word budget: the body has ${args.currentWordCount} words and must fit ${args.wordBudget}. Cut at least ${args.cut} words of prose. That is a hard requirement: count as you go, and cut more rather than less.

# How to cut
- Remove repetition first (a point the key takeaways, a table, or another section already makes), then filler sentences, then wordy phrasing. Shorten the hook bridge, intros, and pros/cons wording before cutting any explanation of the code.
- Keep the first paragraph (the direct answer), every heading, every "**Line N:**" explanation that a program needs (shorten it instead), and every fact.
- Do not touch [code] tags, [table] tags, [image] tags, [[… widget]] blocks, or EDPWIDGET token lines (each on its own line, in place). Keep every link exactly as it is (anchor and URL).
- Keep the exact phrase "${args.primaryKeyword}" only where it already is; never add it.
- Body words are everything except code, tables, images, widgets, and "**Line N:**" code explanations (don't cut those; they explain the playgrounds).

# Answer
${args.draft}

# Output
Return ONLY the shortened Answer Markdown, complete. No comments.`;
}

// ---------------------------------------------------------------------------
// 16) Coverage check — which must-cover facts are missing from the body
// ---------------------------------------------------------------------------
export function edpressoCoverageCheckPrompt(args: {
  title: string;
  items: string;
  draft: string;
}): string {
  return `Check whether the body of the Educative Answer titled "${args.title}" states each fact below. The Quiz and FAQ are not part of the body (they appear as EDPWIDGET tokens), so a fact found only there is missing.

# Facts the body must state
${args.items}

# Answer body
${args.draft}

A fact counts as present only if the body states it clearly (the same meaning; exact wording isn't needed). Return ONLY a JSON object:
{ "missing": [<numbers of the facts that are missing>] }`;
}

// ---------------------------------------------------------------------------
// 17) Coverage fix — adds the missing facts where they belong
// ---------------------------------------------------------------------------
export function edpressoCoverageFixPrompt(args: {
  title: string;
  missing: string;
  wordBudget: string;
  currentWordCount: string;
  draft: string;
}): string {
  return `The Educative Answer titled "${args.title}" is missing these facts that searchers look for:
${args.missing}

Add each one to the body, once, in the section where it belongs: one or two sentences, a "> **Note:** …" blockquote, or a "Points to remember" bullet. State an error or warning with its exact message text in inline code, plus its cause and fix. Keep it accurate and consistent with the rest of the Answer.

# Rules
- Change nothing else. Don't touch [code] tags, [table] tags, [image] tags, [[… widget]] blocks, or EDPWIDGET token lines (each stays on its own line, in place). Keep every link exactly as it is.
- Keep the body within ${args.wordBudget} (now ${args.currentWordCount} words): if needed, shorten a nearby sentence that repeats something.

# Answer
${args.draft}

# Output
Return ONLY the complete Answer Markdown. No comments.`;
}

// ---------------------------------------------------------------------------
// 18) Image sync — image descriptions must match what the programs really print
// ---------------------------------------------------------------------------
export function edpressoImageSyncPrompt(args: {
  title: string;
  programs: string;
  images: string;
}): string {
  return `In the Educative Answer titled "${args.title}", images are generated from their descriptions. The programs were run, and their real output is below. An image that contradicts the output (for example, it shows one clearly broken clustering next to a clean one while the printed results are nearly identical, or it shows different data from the program's) makes readers stop trusting the page.

# Programs and their real output
${args.programs}

# Images (with the text around each)
${args.images}

# Rules
- Check each image (and each slide) against the output and the text around it. If it depicts a result, it must show what the output shows, on the same data (same shape, number of groups, dimensions, and values where shown). No number may appear that the output doesn't print; don't claim "the same dataset" for a picture that can't reproduce its points (describe it as an illustration); depict algorithms as documented (R starts k-means from random data rows, so starting centers sit on points).
- When an image is fine, leave it out of your answer. When it isn't, rewrite its description (2–3 sentences: the components, labels, values, and what is highlighted) and its caption (8–20 words, alt text in sentence case, saying what the image shows).

Return ONLY a JSON object:
{ "images": [ { "n": <image number>, "description": "<text>", "caption": "<text>" } ] }`;
}

// ---------------------------------------------------------------------------
// 19) Related Answers — a Callout pointing to the series or prerequisite Answers
// ---------------------------------------------------------------------------
export function edpressoRelatedCalloutPrompt(args: {
  title: string;
  answers: string;
  sentence: string;
  sections: string;
}): string {
  return `The Educative Answer titled "${args.title}" belongs to a series or needs other Answers read first. Write the Callout that points readers to them and choose where it goes.

# Related Answers
${args.answers}

# Sentence from the author (may be empty)
${args.sentence}

# Sections of the Answer, in order
${args.sections}

# Rules
- If the author gave a sentence, keep every word of it exactly and only turn words in it into Markdown links ([words](URL)), one link per related Answer, on the words that name that Answer's topic. If no sentence was given, write one or two complete sentences in the Answer's voice that say how this Answer relates to them (a prerequisite to read first, or the previous or next part of a series) and link each one on words that name its topic.
- Every related Answer URL appears exactly once, as a Markdown link. No other links. No "click here", "this Answer", or "see".
- placement: for a prerequisite, "start" (right after the key takeaways, before the first section); for a series, "start" when this Answer continues an earlier one, or the heading of the section the related Answer extends, or "end" (before the Quiz) when it is the next part.

Return ONLY a JSON object:
{ "sentence": "<Markdown text with the links>", "placement": "start" | "end" | "<exact section heading>" }`;
}

// ---------------------------------------------------------------------------
// 20) Course link rewrite — last resort: one existing sentence gains a phrase the course teaches
// ---------------------------------------------------------------------------
export function edpressoCourseLinkRewritePrompt(args: {
  title: string;
  course: string;
  sentences: string;
  feedback: string;
}): string {
  return `The Educative Answer titled "${args.title}" must link this course, but no sentence has words that name something the course teaches:
${args.course}

# Candidate sentences (from the Answer body)
${args.sentences}

# Task
Pick the one sentence where the course's subject fits most naturally, and rewrite it minimally so it contains a short noun phrase (2–5 words) naming something the course teaches (for an R course, for example "R functions", "base R", "R's stats package", "R data frames"). The rewritten sentence must:
- keep its meaning and stay one sentence, at most 12 words longer than before, and read as naturally as an editor would write it: work the phrase into the sentence's grammar (for example "…a common pattern in R functions that use randomness"), never wedge it in as an aside ("…is, in base R, the number…") or tack it onto a list ("…in R's kmeans() and base R…");
- keep every inline code span, link, and #key# popup exactly as it is;
- read naturally with the link removed: no mention of a course, path, or resource, and no "learn", "check out", "see", "to learn more", "enroll", or other call to action;
- contain the anchor phrase exactly once, outside inline code, not directly before inline code;
- use a different anchor phrase from any course link already in the Answer.

${args.feedback}

Return ONLY a JSON object:
{ "sentence": <candidate number>, "rewritten": "<the rewritten sentence>", "anchor": "<the noun phrase, copied exactly from the rewritten sentence>" }`;
}

// ---------------------------------------------------------------------------
// 21) Docs check — statements that contradict the official documentation
// ---------------------------------------------------------------------------
export function edpressoDocCheckPrompt(args: {
  title: string;
  docs: string;
  answer: string;
}): string {
  return `Fact-check the Educative Answer titled "${args.title}" against the official documentation below. Readers who trust a wrong statement get wrong results, so find every statement in the Answer (body, notes, key takeaways, Quiz, and FAQ answers) that the documentation contradicts, or that claims behavior the documentation doesn't describe and that is wrong (for example, saying a function "switches to random starts" when the documentation says the argument only applies when centers is a number).

# Official documentation
${args.docs}

# Answer
${args.answer}

# Rules
- Report only real contradictions or false claims, not style. Don't report statements the documentation simply doesn't mention unless you are certain they are false.
- wrong: an exact, contiguous piece of text copied from the Answer (a full sentence or clause), outside code blocks.
- correct: the replacement text, same length or shorter, consistent with the documentation, in the same voice and Markdown.

Return ONLY a JSON object:
{ "corrections": [ { "wrong": "<exact text>", "correct": "<replacement>", "reason": "<what the documentation says>" } ] }`;
}

// ---------------------------------------------------------------------------
// 22) FAQ search terms — what to look up in Educative's Answers for each FAQ
// ---------------------------------------------------------------------------
export function edpressoFaqSearchTermsPrompt(args: {
  title: string;
  faqs: string;
}): string {
  return `For each FAQ of the Educative Answer titled "${args.title}", give 1–2 short search terms (1–4 words each) for finding another Educative Answer that explains a concept, function, or error the FAQ answer mentions (for example "k-means algorithm", "set.seed", "local optimum"). Pick terms for things a reader might want explained in depth, not the Answer's own subject.

# FAQs
${args.faqs}

Return ONLY a JSON object:
{ "terms": [ { "faq": <number>, "queries": ["<term>", "<term>"] } ] }`;
}

// ---------------------------------------------------------------------------
// 23) FAQ links — at most one link per FAQ answer, on words the answer already has
// ---------------------------------------------------------------------------
export function edpressoFaqLinkPrompt(args: {
  title: string;
  faqs: string;
  candidates: string;
}): string {
  return `Add internal links to the FAQ answers of the Educative Answer titled "${args.title}". Each link goes on words an answer already has and points to another Educative Answer that explains exactly those words.

# FAQ answers
${args.faqs}

# Educative Answers you may link (title, then URL)
${args.candidates}

# Rules
- At most one link per FAQ answer; skip an answer when no candidate explains something it mentions. Never force a link.
- Use each candidate at most once. Prefer candidates marked "(not linked in the body yet)".
- anchor: 1–5 consecutive words copied exactly from the answer, naming the concept, function, or error the linked Answer explains (for example "k-means algorithm", "local optimum"). Never words inside backticks, never the whole sentence, never generic words ("here", "this", "more").
- Don't link the question; only the answer.

Return ONLY a JSON object:
{ "links": [ { "faq": <number>, "candidate": <number>, "anchor": "<exact words from that answer>" } ] }`;
}

// ---------------------------------------------------------------------------
// 24) Missing author FAQs — answers for author FAQs the draft left out
// ---------------------------------------------------------------------------
export function edpressoFaqAnswerPrompt(args: {
  title: string;
  language: string;
  questions: string;
}): string {
  return `Write FAQ answers for the Educative Answer titled "${args.title}" (language: ${args.language}). The author requires these questions; answer each one.

# Questions (keep each exactly as written)
${args.questions}

# Rules
- 1–3 sentences each, the direct answer first, technically accurate. A short fenced code snippet is allowed.
- When a question is broader than this Answer's topic, answer it briefly and correctly, then tie it back to this topic in one clause where that fits naturally.
- No links.

Return ONLY a JSON object:
{ "answers": [ { "n": <question number>, "answer": "<answer>" } ] }`;
}

// ---------------------------------------------------------------------------
// 25) Revamp check — does an existing Answer need a revamp under our guidelines?
// ---------------------------------------------------------------------------
export function edpressoAssessPrompt(args: {
  title: string;
  answerTypeLabel: string;
  wordBudget: string;
  typeStructure: string;
  guidelines: string;
  stats: string;
  answer: string;
}): string {
  return `You are the content lead for Educative Answers (short, search-first technical articles that should rank on Google, appear in People also ask and AI overviews, and drive sign-ups through runnable code). Decide whether the existing Answer below should be revamped, judging it only against our guidelines for an ideal Answer.

# Answer
- Title: ${args.title}
- Answer type: ${args.answerTypeLabel}
- Word budget for this type: ${args.wordBudget}
- Measured: ${args.stats}

# Ideal structure for this Answer type
${args.typeStructure}

# Our checklist for an ideal Answer
${args.guidelines}

# The existing Answer (widgets shown in [brackets])
${args.answer}

# How to judge
- Judge substance, not template matching. Lines starting with "#" inside code blocks are code comments, not headings. A Callout that points readers to a prerequisite Answer is allowed. "Measured" body words exclude code, widgets, and "**Line N:**" explanations, exactly as the budget does.
- "revamp" only when the problems are substantial: a rewrite would clearly improve ranking, AI answers, trust, or sign-ups. Typical reasons: no direct answer up front, missing or non-runnable code where code helps, factual errors, outdated or deprecated content, thin coverage of what searchers ask (common errors, defaults, edge cases), no FAQ or quiz, no images, no internal links, or a structure far from the ideal.
- "minor-fixes" when it is mostly sound and a few targeted edits would do, including differences from our template (heading wording, section order, a missing table) that don't hurt the reader or search.
- "keep" when it already meets the guidelines well.
- Be concrete: each reason names what is wrong or missing in this Answer and why it matters. Don't invent problems; if something is good, say so in strengths.

Return ONLY a JSON object:
{
  "verdict": "revamp" | "minor-fixes" | "keep",
  "summary": "<one sentence>",
  "reasons": ["<short bullet>", "..."],
  "strengths": ["<short bullet>", "..."]
}`;
}
