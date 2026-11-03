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
  "reason": "<one sentence explaining the choice>"
}`;
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
   - Relevant history (who created it, when, why).
   - Well-known companies or products that use the technology, when relevant.
6. Collect related long-tail and semantically related (LSI) keywords you observed in titles, headings, autocomplete, and related searches.

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
- Official docs: <page title> — <URL>

## Related keywords
- <keyword>

Rules: Report only what you actually found. If you are not sure a quote is exact, leave it out. Every URL must be one you actually visited or saw in search results.`;
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
2. Official external references (0–5): official language or framework documentation (prefer stable, version-agnostic URLs such as docs.python.org/3/… over pre-release or version-pinned pages), standards bodies (RFCs, ECMA, ISO), the tool's own website, or peer-reviewed or highly authoritative sources. Never include tutorial sites or e-learning competitors (for example GeeksforGeeks, W3Schools, Programiz, TutorialsPoint, Javatpoint, freeCodeCamp, Baeldung, Real Python, Medium, dev.to, Udemy, Coursera, Codecademy, DataCamp) or Q&A forums.

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
}): string {
  return `You are the lead editor for Educative Answers. Plan the structure of a new Answer. The Answer must rank on Google, win featured snippets, and be cited by generative engines (ChatGPT, Gemini, Claude, Perplexity), while teaching the topic well.

# Inputs
- Title: ${args.title}
- Answer type: ${args.answerTypeLabel}
- Body word budget: ${args.wordBudget}
- Programming language: ${args.language}
- Target keywords (search queries people type; cover their meaning, use the exact wording only where it reads as natural English, and never put a keyword in backticks unless it is code): ${args.keywords}
- FAQs the author requires (keep every one, copied exactly as written):
${args.userFaqs}

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
- Every heading must be meaningful on its own and should contain a keyword where natural. Numbered headings use the form "Method 1: <what it does>" or "1. <Action> using <thing>".
- Plan where each target keyword and related keyword appears (title, first paragraph, headings, code captions, FAQs). Do not stuff keywords.
- Choose the authority elements from the research brief: one expert quote or fun fact (only if the research found a real one with a source), facts or statistics with sources, history, official docs. Prefer these over anecdotes.
- FAQs: keep every author FAQ word for word, then add 3–5 questions from "People also ask" that the body does not already answer and that are not duplicates of an author FAQ. Aim for 8–15 FAQs in total (fewer only if the topic genuinely has fewer distinct questions).

# Output
Return ONLY a JSON object:
{
  "primaryKeyword": "<main search phrase>",
  "calloutQuote": { "text": "<exact quote or fun fact>", "attribution": "<person and role, or 'Fun fact'>", "sourceUrl": "<URL or empty>" } | null,
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
}): string {
  return `You are a senior technical writer for Educative Answers. Write the complete Answer described below.

# Inputs
- Title (already set separately; do NOT repeat it as a heading): ${args.title}
- Answer type: ${args.answerTypeLabel}
- Body word budget: ${args.wordBudget}
- Programming language for code: ${args.language}
- Target keywords (search queries people type; cover their meaning, use the exact wording only where it reads as natural English, and never put a keyword in backticks unless it is code): ${args.keywords}

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
- Place the primary keyword in the first paragraph and in at least one heading. Spread related keywords naturally through headings, body text, code captions, and FAQs. No keyword stuffing.
- Target keywords are search phrases, not strings to paste. Reorder, inflect, and capitalize them so every sentence stays grammatical: write "how to reverse a list in Python" or "the Python \`reversed()\` function", never "\`reversed()\` python for backward iteration" or "this modulenotfounderror appears". Search engines match the meaning; broken grammar costs trust. If a keyword cannot be used naturally, leave it out.

# Links
- Link ONLY to URLs from the verified links list. Never write any other URL.
- Turn the relevant words into the link anchor; never write "click here", "this Answer", or "see this".
- Prefer internal Educative and how.dev links. Use official external links only as sources for facts, quotes, or documentation.
- If the verified list is empty, write no links.
- Close the Answer with a natural pointer to a verified Educative course or path link when one is available.

# Keyword popups
- For 2–5 technical terms a newcomer may not know (jargon, acronyms, named algorithms or tools) that need only a one-line explanation, use Educative's inline keyword popup syntax exactly: #key# <term>: <one-sentence definition> #key#
- Never turn a target keyword, a command, or a common word into a popup just to repeat it. The popup term must read naturally as part of the sentence.
- Readers see only the term; the definition appears on hover. So the sentence must read correctly with the popup replaced by its term alone, and any punctuation that ends or continues the sentence goes AFTER the closing #key# ("…returns a reverse #key# iterator: An object that yields values one at a time. #key#. Use it when…").
- Example: "Random numbers are used to generate #key# OTP: One-time password, a code valid for a single login or transaction. #key# codes."
- Define each term once, at first use. Never make a separate glossary.

# Output format (pure Markdown, no preamble, no title heading)

1. If the outline has a callout quote or fun fact, start with it as a Callout widget placeholder:
[[Callout widget]]
"<exact quote>" — <Name>, <role>
[[/Callout widget]]

2. Then the key takeaways blockquote. Each bullet must be useful on its own (not a table of contents); use bold labels where they help:
> **Key takeaways:**
> - **<Label>:** <takeaway>
> - <takeaway>

3. Then the body. Use "##" for sections and "###" for subsections, in sentence case. Do not use "#".

4. Code: write the full, correct, runnable code yourself inside a code tag, in exactly this shape:
[code]
Language: <language>
Caption: <keyword-rich caption describing what the code does>
\`\`\`<language>
<complete runnable program with brief comments on key lines>
\`\`\`
[/code]
   - Give the bigger picture before the code, then explain the code after it, referring to line numbers in bold ("**Lines 4–6:** …"). Count the lines in your code carefully so every line reference is correct.
   - Programs must compile and run as written and print visible output. Keep them short and focused.
   - Use short inline code (\`like_this()\`) for syntax snippets; use a code tag only for a complete program.

5. Tables: write the table yourself, in exactly this shape:
[table]
Table title: <descriptive, keyword-rich title>
| Header | Header |
|---|---|
| cell | cell |
[/table]

6. Images: only when a picture teaches something (a step-by-step walkthrough, an architecture, a data layout). Never decorative. At most two:
[image][Description]<2–3 lines describing exactly what the illustration shows, including labels and values>[/Description][Caption]<short caption in sentence case>[/Caption][/image]

7. Other widgets are placeholders. Write their FULL content so an editor can paste it straight into the Educative widget. Use exactly these wrappers:
[[Slides widget]]
Slide 1: <what the slide shows>
Slide 2: <what the slide shows>
[[/Slides widget]]

[[LaTeX widget]]
<LaTeX expression>
[[/LaTeX widget]]

8. Notes and warnings use blockquotes: "> **Note:** …".

9. End with, in this order:
   a. A short closing section with a meaningful heading that summarizes the Answer and, when a verified course or path link exists, points to it.
   b. If the outline says includeQuiz is true, a Quiz widget placeholder with 3 multiple-choice questions, 4 options each:
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
   c. The FAQ widget placeholder with every FAQ from the outline, in order, questions copied exactly (never reword an author FAQ). Each answer is 1–3 sentences, starts with the direct answer, may include a short fenced code snippet, and may link one related verified page:
[[FAQ widget]]
Q: <question exactly as planned>
A: <answer>

Q: …
A: …
[[/FAQ widget]]

# Word budget
- The body (everything except code tags, table tags, image tags, [[… widget]] placeholders, and FAQ answers) must stay within ${args.wordBudget}. Be as brief as the topic allows.

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
  draft: string;
}): string {
  return `You are the final reviewer for Educative Answers. Audit the draft below against the checklist, fix every problem, and return the corrected Answer.

# Context
- Title: ${args.title}
- Answer type: ${args.answerTypeLabel}
- Body word budget: ${args.wordBudget}
- Current body word count (measured by code; excludes code, tables, images, widget placeholders, and FAQ answers): ${args.currentWordCount}
- The Quiz and FAQ widgets have been removed from the draft and are re-attached after your output. Do not write a Quiz or FAQ widget.
- Target keywords (search queries people type; cover their meaning, use the exact wording only where it reads as natural English, and never put a keyword in backticks unless it is code): ${args.keywords}

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
6. Primary keyword in the first paragraph and at least one heading; related keywords appear naturally; no stuffing.
7. No vague claims, hyperbole, flowery language, clichés, anecdotes, or first-person stories. Tone is authoritative and positive.
8. Every technical claim is correct. Code compiles, runs, prints output, and every "**Line N:**" reference points to the right line. Fix the code or the references if they disagree.
9. Every URL appears in the verified links list. Remove any other link (keep its anchor text as plain text). Anchors are descriptive words, never "click here".
9b. Target keywords appear in natural, grammatical wording with correct capitalization. Rewrite any phrase where a keyword was pasted verbatim and reads wrong (for example "\`reversed()\` python for…" → "the Python \`reversed()\` function for…").
10. Keyword popups use the exact syntax "#key# term: definition #key#", appear 2–5 times, and only explain jargon. Read each sentence with the popup replaced by its term alone; it must still be correct, with sentence punctuation after the closing #key#. Remove popups that merely repeat a target keyword or wrap a command, and fix keywords inserted with wrong casing or broken grammar.
11. Widget syntax is intact: [code]…[/code] with Language, Caption, and a fenced block; [table]…[/table] with "Table title:"; [image][Description]…[/Description][Caption]…[/Caption][/image]; and [[X widget]]…[[/X widget]] placeholders.
12. The body ends with the closing section (the Quiz and FAQ widgets are attached after it automatically).
13. Lists are ordered logically (most important first). Paragraphs open with their key point. No repeated words in consecutive sentences.

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
  widgets: string;
}): string {
  return `You are the technical fact-checker for the Quiz and FAQ widgets of an Educative Answer titled "${args.title}" (language: ${args.language}).

# Target keywords (search queries; use their meaning, never paste them ungrammatically or in backticks unless they are code)
${args.keywords}

# Verified links (the only URLs allowed)
${args.verifiedLinks}

# Widgets to review
${args.widgets}

# Rules
- Keep every question, in the same order, with its wording unchanged. Do not add or remove questions.
- Check every answer, option, correct-answer letter, explanation, and code snippet for technical accuracy against the official behavior of the language or tool. Fix anything wrong or unverifiable; if a claim cannot be stated accurately, replace it with a correct, simpler statement.
- FAQ answers: 1–3 sentences, the direct answer first, correct casing, natural grammar. A short fenced code snippet is allowed.
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
