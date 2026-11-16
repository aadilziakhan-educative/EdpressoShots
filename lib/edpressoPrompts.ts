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
   - Relevant history: who created the language, library, tool, or function, and when (one line each).
   - What the name stands for when it is an acronym or abbreviation (for example "grepl" = "grep logical", "cURL" = "Client for URL").
   - Hook material: a surprising, verifiable fact or statistic about the topic, and a concrete real-world scenario in which a developer runs into the exact problem this Answer solves.
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
- Name: <what the name stands for> — Source: <URL>
- Hook fact: <surprising fact or statistic> — Source: <URL>
- Hook scenario: <a concrete situation where a developer needs this>
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
  imageCount: string;
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
- Hook (required): plan one opening hook that makes the reader stop. Prefer, in order: (1) a real quote from a recognized person, from the research, that is directly about this topic; (2) a surprising, sourced fact or statistic; (3) a concrete real-world scenario in which the reader hits this exact problem (for example "filtering a summer sale so no winter products appear"). Never invent a quote or attribute one loosely; never use a generic quote that would fit any article. Plan the bridge: one sentence that ties the hook to the topic.
- Optionally plan one more quote (sectionQuote) for a section break, only if the research has a real, relevant one; it must be followed by a sentence that connects it to that section.
- Choose the other authority elements from the research brief: facts or statistics with sources, the creator and year of the language, library, tool, or function (one clause), what the name stands for, official docs. Prefer these over anecdotes.
- Plan one running example (concrete values or a small dataset) and reuse it across every method or step, so readers compare techniques on the same input. For data topics, prefer a real built-in or well-known dataset (for example R's mtcars or PlantGrowth, seaborn's tips) over made-up values.
- Plan one "pause and think" question (pauseQuestion): a short open question a reader is likely to wonder about at that point (an edge case, a common confusion, or a likely follow-up search), with a 1–3 sentence answer, placed right after the section that raises it. It must not repeat an FAQ. Skip it only for error Answers under 150 planned words.
- Images: plan exactly ${args.imageCount}. Put the "image" element on the section(s) where a picture teaches the most (a step-by-step walkthrough, an architecture, a data layout, a before/after, or how a fix changes the state). Never decorative, and at most one image per section.
- FAQs: keep every author FAQ word for word, then add 3–5 questions from "People also ask" that the body does not already answer and that are not duplicates of an author FAQ. Aim for 8–15 FAQs in total (fewer only if the topic genuinely has fewer distinct questions).

# Output
Return ONLY a JSON object:
{
  "primaryKeyword": "<main search phrase>",
  "hook": { "type": "quote" | "fact" | "scenario", "text": "<exact quote, fact, or scenario>", "attribution": "<person and role for a quote, otherwise empty>", "sourceUrl": "<URL or empty>", "bridge": "<sentence that ties the hook to the topic>" },
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
  courseLinks: string;
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

# Course links (weave each one in subtly)
${args.courseLinks}

- When course links are listed above, use each one exactly once, in the body prose (a paragraph or a list item). Never in a heading, the key takeaways, a code tag, a table, an image tag, the Quiz, or the FAQ.
- The anchor must be words the sentence needs anyway and that relate to what the course teaches: a fact, a keyword or concept name ("[dynamic programming](…) breaks a problem into overlapping subproblems"), or an example ("[building a REST API](…) with Flask").
- The sentence must read exactly the same with the link removed. Never mention that a course, path, or resource exists, never name the course or use its title as the anchor ("learn Python", "Grokking…"), never say a topic is "covered in", "taught in", or "explained in" something, and never write calls to action: no "this course", "the following course", "to learn more", "check out", "have a look", "take a look", "enroll", "sign up", "start learning", or "see".
- Keep anchors short (one to five words), never link a whole sentence, and never put a link inside a "#key# … #key#" keyword popup.

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
- Never bold a keyword to highlight it; bold only labels and genuinely important terms.
- Target keywords are search phrases, not strings to paste. Reorder, inflect, and capitalize them so every sentence stays grammatical: write "how to reverse a list in Python" or "the Python \`reversed()\` function", never "\`reversed()\` python for backward iteration" or "this modulenotfounderror appears". Search engines match the meaning; broken grammar costs trust. If a keyword cannot be used naturally, leave it out.

# Links
- Link ONLY to URLs from the verified links list. Never write any other URL.
- Turn the relevant words into the link anchor; never write "click here", "this Answer", or "see this".
- Prefer internal Educative and how.dev links. Use official external links only as sources for facts, quotes, or documentation.
- If the verified list is empty, write no links.
- Link verified Educative course or path pages like any other page: on words the sentence needs anyway. Never point the reader to a course or path ("this course", "to learn more", "check out", "take a look", "enroll"), and never end the Answer with such a pointer.

# Keyword popups
- For 2–5 technical terms a newcomer may not know (jargon, acronyms, named algorithms or tools) that need only a one-line explanation, use Educative's inline keyword popup syntax exactly: #key# <term>: <one-sentence definition> #key#
- Never turn a target keyword, a command, or a common word into a popup just to repeat it. The popup term must read naturally as part of the sentence.
- Readers see only the term; the definition appears on hover. So the sentence must read correctly with the popup replaced by its term alone, and any punctuation that ends or continues the sentence goes AFTER the closing #key# ("…returns a reverse #key# iterator: An object that yields values one at a time. #key#. Use it when…").
- Example: "Random numbers are used to generate #key# OTP: One-time password, a code valid for a single login or transaction. #key# codes."
- Define each term once, at first use. Never make a separate glossary.

# Output format (pure Markdown, no preamble, no title heading)

1. Open with the outline's hook. For a quote or a fact, start with a Callout widget placeholder:
[[Callout widget]]
"<exact quote>" — <Name>, <role>
[[/Callout widget]]
(for a fact: the fact itself, with no attribution line). For a scenario hook, there is no Callout: the first body paragraph after the key takeaways opens with the scenario. In every case, the first body paragraph connects the hook to the topic in one sentence (the outline's bridge), so the hook leads into the Answer instead of standing alone.

2. Then the key takeaways blockquote. Each bullet must be useful on its own (not a table of contents) and specific to this topic; use bold labels where they help. Never restate the parameter list or say something generic such as "the best method depends on your needs":
> **Key takeaways:**
> - **<Label>:** <takeaway>
> - <takeaway>

3. Then the body. Use "##" for sections and "###" for subsections, in sentence case. Do not use "#".
   Never place two elements back to back: a code tag, table, image, fenced block, or any [[… widget]]. Put at least one full sentence between any two of them that tells the reader what the next element shows (a heading alone does not count).

4. Code: write the full, correct, runnable code yourself inside a code tag, in exactly this shape:
[code]
Language: <language>
Caption: <keyword-rich caption describing what the code does>
\`\`\`<language>
<complete runnable program with brief comments on key lines>
\`\`\`
[/code]
   - Give the bigger picture before the code, then explain the code after it, referring to line numbers in bold ("**Lines 4–6:** …"). Count the lines in your code carefully so every line reference is correct.
   - Programs must compile and run as written and print visible output. Keep them short and focused. Use the current, supported version of the language (for example Python 3 \`print()\`).
   - Put every piece of code that can run inside a code tag, so readers can edit and run it on Educative. This includes short demonstrations: make them complete, minimal programs (imports, a main function where the language needs one, and printed output) rather than fragments. Name the key line in the sentence before the program and keep it near the top. A runnable program must really perform the operation it teaches and print the real result; never write a script that only prints or echoes the commands it describes. For tools such as Git, build a throwaway setup inside the script (for example a temporary repository plus a local bare repository as its "origin", with git user.name and user.email set) so the real commands run end to end without network access or an editor. If the operation cannot run that way, show the commands in a Terminal widget instead. A code tag must run exactly as written: no placeholders such as <sha> or <branch>, no commands that open an editor or wait for input (for example git rebase -i, vim, read), and it must create anything it uses. Use a plain fenced block only for code that cannot run on its own: a syntax or signature line, a reference list of commands, a configuration file, a command's output, or pseudo-code. Shell commands go in a Terminal widget. Use short inline code (\`like_this()\`) for names in sentences.
   - Reuse the outline's running example in every program, so only the technique changes between methods.
   - Every code caption is unique and says what that specific program shows; never leave a caption empty or copy it from another block.
   - When the output is not obvious (a surprising value, a flag that changes behavior, a difference between methods), explain after the program what it prints and why each value appears; quote the key output line inline or in a short fenced block introduced by a full sentence.
   - When methods behave differently on some input, prove it with one short program that runs both on that input and prints the difference, instead of only stating it.

5. Tables: write the table yourself, in exactly this shape:
[table]
Table title: <descriptive, keyword-rich title>
| Header | Header |
|---|---|
| cell | cell |
[/table]

6. Images: include exactly ${args.imageCount}, in the sections the outline marks with "image". Each must teach something (a step-by-step walkthrough, an architecture, a data layout, a before/after); never decorative. Place each image right after the paragraph it illustrates, in exactly this shape:
[image][Description]<2–3 sentences describing exactly what the illustration shows: the specific components, their labels, the values, and the arrows or data flow between them>[/Description][Caption]<short caption in sentence case>[/Caption][/image]

7. Other widgets are placeholders. Write their FULL content so an editor can paste it straight into the Educative widget. Use exactly these wrappers:
[[Slides widget]]
Slide 1: <what the slide shows>
Slide 2: <what the slide shows>
[[/Slides widget]]

[[LaTeX widget]]
<LaTeX expression>
[[/LaTeX widget]]

   If the outline has a pauseQuestion, place it right after the section that raises it, using exactly this wrapper (the answer stays hidden until the reader clicks):
[[Pause and think widget]]
Q: <question>
A: <answer>
[[/Pause and think widget]]

   For command-line tools, shell commands, and installation steps, add a hands-on block after the commands are explained: one sentence asking the reader to try them, then
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
   b. A short closing section with a meaningful heading that summarizes the Answer. No call to action and no pointer to a course or path. It sits between the Quiz and the FAQ, so they are never back to back.
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
  courseLinks: string;
  draft: string;
}): string {
  return `You are the final reviewer for Educative Answers. Audit the draft below against the checklist, fix every problem, and return the corrected Answer.

# Context
- Title: ${args.title}
- Answer type: ${args.answerTypeLabel}
- Body word budget: ${args.wordBudget}
- Current body word count (measured by code; excludes code, tables, images, widget placeholders, and FAQ answers): ${args.currentWordCount}
- The Quiz and FAQ widgets have been removed from the draft and are re-attached after your output, at the lines that read EDPWIDGET0TOKEN, EDPWIDGET1TOKEN, and so on. Keep each of those lines exactly where it is, and do not write a Quiz or FAQ widget.
- Target keywords (search queries people type; cover their meaning, use the exact wording only where it reads as natural English, and never put a keyword in backticks unless it is code): ${args.keywords}

# Required structure for this Answer type
${args.typeStructure}

# Verified links (the only URLs allowed)
${args.verifiedLinks}

# Course links (each must appear exactly once, subtly)
${args.courseLinks}

# Checklist
1. Length: if the body is over budget, tighten it (cut filler, merge repeated points, shorten examples) until it fits. Never pad a draft that is under budget.
2. Structure matches the Answer type, in order. The key takeaways blockquote exists and each bullet stands on its own.
3. A "What is…" (or "What causes…") section opens with a neutral 40–60 word definition.
4. The first one or two sentences under every heading answer that heading directly. Sections are self-contained.
5. Headings are meaningful, sentence case, use "##"/"###" only, and numbered where the content is a sequence of methods or steps.
6. Primary keyword in the first paragraph and at least one heading; related keywords appear naturally; no stuffing.
7. No vague claims, hyperbole, flowery language, clichés, anecdotes, or first-person stories. Tone is authoritative and positive.
8. Every technical claim is correct. Code compiles, runs, prints output, and every "**Line N:**" reference points to the right line. Fix the code or the references if they disagree.
8b. Course links: each listed course link appears exactly once, in body prose, anchored on a fact, keyword, concept, or example the sentence needs anyway. The sentence reads the same with the link removed. Remove any mention of a course or resource, any anchor that names the course, any "covered in"/"taught in" wording, and any call to action around it ("this course", "to learn more", "check out", "have a look", "enroll"). Never drop a course link; move it to a better phrase instead.
9. Every URL appears in the verified links list or the course links list. No sentence points the reader to a course or path ("this course", "to learn more", "check out", "take a look", "enroll"), including in the closing section; rewrite such a sentence so its link sits on words it needs anyway, or remove the sentence. Remove any other link (keep its anchor text as plain text). Anchors are descriptive words, never "click here".
9b. No keyword is bolded just to highlight it. A creator or year appears only for the exact subject (never the language's creator in an Answer about a function or feature). Search the draft for each target keyword written word for word; wherever that exact wording is not grammatical English in its sentence, rewrite the phrase (for example "why re.sub python usage matters" → "why Python's \`re.sub()\` matters"). Target keywords appear in natural, grammatical wording with correct capitalization. Rewrite any phrase where a keyword was pasted verbatim and reads wrong (for example "\`reversed()\` python for…" → "the Python \`reversed()\` function for…").
10. Keyword popups use the exact syntax "#key# term: definition #key#", appear 2–5 times, and only explain jargon. Read each sentence with the popup replaced by its term alone; it must still be correct, with sentence punctuation after the closing #key#. Remove popups that merely repeat a target keyword or wrap a command, and fix keywords inserted with wrong casing or broken grammar.
11. Keep every [image] tag the draft has; never remove or merge images. Widget syntax is intact: [code]…[/code] with Language, Caption, and a fenced block; [table]…[/table] with "Table title:"; [image][Description]…[/Description][Caption]…[/Caption][/image]; and [[X widget]]…[[/X widget]] placeholders.
12. The Quiz token (if any) comes after a sentence inviting the reader to check their understanding and before the closing section; the FAQ token comes last.
13. Lists are ordered logically (most important first). Paragraphs open with their key point. No repeated words in consecutive sentences.
14. The Answer opens with a hook (a Callout quote or fact, or a scenario in the first paragraph) and the first body paragraph ties it to the topic. A quote must be relevant to this topic and attributed to a named person; replace a generic or unattributed quote with a sourced fact or a concrete scenario.
15. Key takeaways are specific to this topic; none restates the parameter list or says something generic.
16. Every method or step reuses the same running example; any code that can run is a complete program in a code tag (only syntax lines, configuration, output, and pseudo-code stay as plain fenced blocks; shell commands go in a Terminal widget); every code caption is unique and describes its own program; non-obvious output is explained.
16b. No two elements (code tag, table, image, fenced block, [[… widget]], or EDPWIDGET token) are back to back: at least one full sentence introducing the next element sits between them.
17. Keep every [[Pause and think widget]], [[Terminal widget]], and [[Callout widget]] intact. A Terminal widget has a "Setup:" part (non-interactive commands that prepare the environment) and a "Try:" part (commands that work in that environment and never open an editor or wait for input). No program only echoes or prints the commands it describes; replace such a program with one that really runs them, or with the Terminal widget.

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
- caption: a short caption in sentence case.

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
}): string {
  return `You are adding course links to an Educative Answer titled "${args.title}". Each link must read as an ordinary anchor on words the sentence already has, never as an advert.

# Course links to place
${args.tasks}

# Candidate sentences (from the Answer body)
${args.sentences}

# Rules
- For each course link, pick the candidate sentence whose topic relates most closely to what the course teaches. Use a different sentence for each course.
- anchor: one to five consecutive words copied exactly from that sentence: a fact, a keyword, a concept name, or an example. Never words inside backticks, never the course's name, and never words starting with "learn", "master", or "explore".

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
