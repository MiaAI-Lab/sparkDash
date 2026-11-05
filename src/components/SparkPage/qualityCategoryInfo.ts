import type { QualityCategory } from "../../api/types";

/** Plain-language explanation of one Quality category, shown under "How it works". */
export interface QualityCategoryInfo {
  /** What a good score says about the model. */
  measures: string;
  /** What is sent and how. */
  how: string;
  /** How a reply becomes pass / fail. */
  scoring: string;
  /** A prompt of the kind the category sends (shortened where the real ones are long). */
  example: string;
  /** Run settings and rough cost. */
  settings: string;
}

export const QUALITY_CATEGORY_INFO: Record<QualityCategory, QualityCategoryInfo> = {
  qa: {
    measures: "Basic accuracy on short, checkable questions: arithmetic, strings, dates. A quick sanity check that nothing is badly broken (a bad quantisation or KV-cache format shows up here first).",
    how: "150 short questions: 26 fixed ones plus 124 generated from a fixed seed (multiplication, add/subtract, sorting, date offsets, least common multiple). The model answers directly, with thinking off. String reversal, letter counts and binary moved to the Tokenizer category in suite v2.",
    scoring: "The reply has to commit to the answer, not just mention it. Numbers: the last number in the reply must be the answer (\"1391\" or \"391 or 5\" fail). Dates: the last date. Sorted lists: the last numbers, in order. Words and reversed strings: the answer as a whole word in a short reply, or a longer reply that ends on it. A reply that leads with the right number and then corrects itself, or hedges around the word (\"not Canberra\"), fails. A request error or timeout is not scored.",
    example: "What is 17 * 23?",
    settings: "Thinking off · 256 tokens per answer · fast.",
  },
  reason: {
    measures: "Multi-step reasoning: keeping several quantities straight through a story and doing the arithmetic in order.",
    how: "200 word problems in five shapes, 40 each: items pooled and split into boxes with a leftover jar; a purchase with a discount and change; two trips at steady speeds with a stop; ages now and in some years; a crate shared in stages. Every problem asks for two whole numbers.",
    scoring: "The last line must be 'Answer: <first>, <second>' in the final answer (not the reasoning). Both numbers must be exactly right.",
    example: "Ana has 40 apples. Ben has 3 times as many as Ana. Cy has 12 … How many are in the jar, and how many in each box? End with 'Answer: <jar>, <per box>'.",
    settings: "Thinking on · up to 8192 tokens per answer · slower on thinking models.",
  },
  arith: {
    measures: "Exact arithmetic over a long chain, where one slip anywhere makes the final number wrong.",
    how: "200 chains: start from a 3-digit number and apply 10 operations (100 chains) or 20 operations (100 chains) in order: multiply, add, subtract, remainder then add 1000, divide rounding down. The model writes the value after every step and then the final number.",
    scoring: "Passes when the last 'Answer: <number>' line equals the true result (markdown and thousands commas are accepted). Graded as well: the share of 'Step n: <value>' lines whose value is right, with an interval, so a chain that slips at step 17 still shows 16 right steps.",
    example: "Start with 482. Then, in order: (1) multiply it by 7; (2) add 1530; … (10) divide it by 4, rounding down. After each step write a line 'Step <n>: <value>', then end with 'Answer: <final number>'.",
    settings: "Thinking on · up to 12288 tokens per answer · slow.",
  },
  track: {
    measures: "Keeping state straight over a long sequence of small changes, like tracking variables through a program.",
    how: "200 stories with five people who each start with some tokens, followed by 25 events (100 stories) or 50 events (100 stories): gives some to another, finds a few, or gives half (rounded down). The question is how many tokens every person has at the end.",
    scoring: "Passes when every total on the last 'Answer: Ana=<n>, Bo=<n>, …' line is right. Graded as well: the share of people whose total is right, with an interval.",
    example: "Track the tokens carefully. Ana starts with 34 tokens. … Ana gives 5 to Bo. Bo finds 3. … How many tokens does each person have at the end? End with 'Answer: Ana=<number>, Bo=<number>, …'.",
    settings: "Thinking on · up to 12288 tokens per answer · slow.",
  },
  gsm8k: {
    measures: "Grade-school maths word problems, the public GSM8K benchmark, so results can be read next to published numbers (as an approximation, see below).",
    how: "188 problems: the bench's fixed 200-item sample of the GSM8K test set re-labelled with GSM8K-Platinum (MIT), which removed twelve mislabeled or ambiguous items and revised two references. The model solves each step by step and ends with its answer.",
    scoring: "The last 'Answer: <number>' line (any capitalisation) must equal the dataset's final answer. $ signs, thousands commas, a % sign or a unit after the number (\"18 dollars\") are fine; a second value or a hedge is not.",
    example: "A real GSM8K problem, e.g. a shop-and-change or distance-and-time story, followed by “Solve it step by step. End with 'Answer: <number>'.”",
    settings: "Thinking on · up to 8192 tokens per answer. A sample of 200, not all 1,319, so a single score is only good to about ±4–7 points (95%); use the paired comparison for small differences, and do not compare with published GSM8K numbers.",
  },
  mmlupro: {
    measures: "Knowledge plus reasoning across 14 fields, on questions that resist guessing: MMLU-Pro replaces plain MMLU's four options with up to ten and drops the trivially easy items, so strong models no longer sit at the ceiling.",
    how: "300 questions, a fixed stratified sample of the public MMLU-Pro test split (21–22 from each of its 14 categories: biology, business, chemistry, computer science, economics, engineering, health, history, law, maths, philosophy, physics, psychology, other). Thinking on, up to 6144 tokens (4096 cut off 8 of 300 GLM-5.3-Flash answers).",
    scoring: "The last 'Answer: <letter>' line (or a bare letter, or a final 'C. …' option line) must be the right letter, A to J.",
    example: "The following is a multiple choice question about physics. … A. … B. … J. … Think it through, then end your reply with a line 'Answer: <letter>'.",
    settings: "Thinking on · up to 6144 tokens per answer · slow on thinking models. In the default profile since suite v2; plain MMLU stays optional.",
  },
  math500: {
    measures: "Competition mathematics: algebra through precalculus at five difficulty levels, with exact answers that are expressions, not just numbers.",
    how: "The 500 problems of MATH-500 (the Let's Verify Step by Step subset of the MIT-licensed MATH dataset), thinking on with an 8192-token budget. Off by default: it is slow.",
    scoring: "The last 'Answer:' line in a canonical form (\\boxed, $, \\left/\\right, \\text, spaces, degree and percent signs removed; \\dfrac → \\frac; a simple \\frac{a}{b} read as a/b) must equal the reference; two plain numbers or fractions also match by value.",
    example: "Convert the point (0,3) in rectangular coordinates to polar coordinates. … End your reply with a line 'Answer: <final answer>'.",
    settings: "Thinking on · up to 8192 tokens per answer · slow · off by default.",
  },
  mmlu: {
    measures: "Broad knowledge and exam-style reasoning across 57 subjects (law, medicine, maths, history, computer science and more), the public MMLU benchmark. Saturated for strong models; MMLU-Pro took its place in the default profile, and this stays for comparisons with older runs.",
    how: "285 multiple-choice questions: 5 from each of the 57 subjects, drawn once with a fixed seed from the MMLU test set (MIT-licensed). Each shows four options A to D.",
    scoring: "The last 'Answer: <letter>' line (any capitalisation; text after the letter such as \"B. Paris\" is fine, \"B or C\" is not), or a reply that is just the letter, must match the correct option.",
    example: "The following is a multiple choice question about astronomy. … A. … B. … C. … D. … Reply with the letter of the correct answer.",
    settings: "Thinking off · up to 1,024 tokens per answer · quick. 285 questions, so a single score is only good to about ±5 points (95%); use the paired comparison for small differences, and do not compare with published few-shot MMLU numbers.",
  },
  follow: {
    measures: "Following exact formatting instructions, the kind of thing that breaks pipelines that parse a model's output. Inspired by IFEval.",
    how: "40 short writing tasks, each with 2 to 4 verifiable rules such as an exact number of bullet points, all lowercase or all capitals, a word count, required or forbidden words, no commas, a title in <<double brackets>>, or an exact closing phrase.",
    scoring: "Every rule is checked by code, not by another model. A task passes only when all of its rules are met.",
    example: "Write a short piece about how bees make honey. 1. Use exactly 4 bullet points, each starting with “* ”. 2. Do not use any commas.",
    settings: "Thinking off · up to 1024 tokens per answer · quick. Off by default so older overall scores stay comparable.",
  },
  long: {
    measures: "Remembering and updating facts in a long document: whether the model finds the latest value, not a stale one, deep in a large context.",
    how: "A long filler text with 16 “Remember this: the code for <animal> is <5 digits>” facts placed early, in the middle or spread through the first part (three needle depths, by item), four of them corrected near the end. The model is asked for the current code of every animal. You choose the context sizes (8k up to 256k) and how many items per size (default 3, one per depth).",
    scoring: "Passes when all 16 latest codes are right; graded as well by the share of keys found, with a prompt-clustered interval. A code that was corrected but answered with its old value counts as stale.",
    example: "… Remember this: the code for otter is 48213. … Correction: the code for otter has changed, it is now 90471. … What is the current code for every animal?",
    settings: "Thinking off · sequential, one at a time · can take many minutes at large sizes, and sizes that do not fit the model's context are skipped.",
  },
  tokenizer: {
    measures: "How the model copes with sub-word puzzles: reversing a string, counting a letter, writing a number in binary. These are decided by how the tokenizer splits text rather than by reasoning, so every model fails some of them thinking-off; a quantisation that changes them changes something real, but the number says little about general quality.",
    how: "44 items: 4 fixed questions plus 40 generated from a fixed seed (15 string reversals, 15 letter counts, 10 binary conversions), thinking off. They were a fifth of QA until suite v2 and are off by default.",
    scoring: "The same rules as QA: the reply must commit to the answer (the reversed string as a whole word, the last number, the last run of binary digits).",
    example: "Reverse the string 'qwmbtx'. Answer with the reversed string only.",
    settings: "Thinking off · 256 tokens per answer · fast · off by default.",
  },
  fidelity: {
    measures: "How closely the served model's token probabilities match the original: the measure that sees a quantisation's damage directly, long before it shows as a wrong answer. Alone it reports perplexity; against a reference run of the original weights it reports the paired change in per-token loss.",
    how: "A fixed corpus of 9 documents (about 34k tokens: technical prose, code, worked maths, Chinese UI text — all from this MIT repository and the bench's own generator) is sent whole to the model's completions route asking only for the prompt's log-probabilities and no generation. Only engines that return prompt log-probabilities (TensorFold, vLLM) can run it; the engine probe decides.",
    scoring: "Per token the exact log-probability the model gave the true next token. Reported as token-weighted NLL (negative log-likelihood per token), perplexity and bits per byte. Comparing with a reference run: paired ΔNLL with a bootstrap interval over documents (positive = this run is worse), top-1 agreement, tail loss (how often the reference's most likely token falls outside this run's top-K) and a truncated-support divergence that is a diagnostic, not a KL.",
    example: "<the whole document as the prompt> · max_tokens 1 · prompt_logprobs 20",
    settings: "No generation · sequential · about a minute on a fast engine · the per-position data is kept in a side file so two runs can be compared token by token · runs on different tokenisations are not paired.",
  },
  divergence: {
    measures: "How a serving stack changes what the model writes: whether two builds produce the same replies, where they start to differ, whether long generations drift, loop or fail to stop, and whether structured output (JSON, tool calls) stays well-formed. Works on any chat endpoint, so it is the fallback where fidelity is unsupported.",
    how: "120 fixed prompts, greedy and seeded, thinking off: prose continuation, code, maths, instruction following, JSON records, tool calls with a tools list, ten languages, two-turn conversations with a correction, and five essays of about 1,000 words. Every reply is stored in full.",
    scoring: "No pass rate and never in the overall. Alone: termination rate, loop rate (a repeating word cycle covering a good share of the reply), JSON validity and schema, tool-call name and arguments. Against a compared run: identical replies, the character where replies first diverge, normalised edit distance over the first 1,200 characters, length ratio, and long-generation drift at about 256, 1,024 and 2,048 tokens. Reply identity measures sensitivity to the serving stack, not correctness.",
    example: "Write a JavaScript function `chunk(array, size)` that splits the array into consecutive chunks of the given size. Return only the code, no explanation.",
    settings: "Thinking off · up to 384 tokens per reply, 2048 for the essays · about 120 requests · compare against a run on the same engine to read the differences as the build's, not the engine's.",
  },
};
