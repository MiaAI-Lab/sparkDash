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
    how: "150 short questions: 30 fixed ones plus 120 generated from a fixed seed (multiplication, add/subtract, reversing a string, counting letters, sorting, binary, date offsets, least common multiple). The model answers directly, with thinking off.",
    scoring: "The reply has to commit to the answer, not just mention it. Numbers: the last number in the reply must be the answer (\"1391\" or \"391 or 5\" fail). Dates: the last date. Sorted lists: the last numbers, in order. Words and reversed strings: the answer as a whole word in a short reply, or a longer reply that ends on it. A reply that leads with the right number and then corrects itself, or hedges around the word (\"not Canberra\"), fails. A request error or timeout is not scored.",
    example: "What is 17 * 23?",
    settings: "Thinking off · at least 64 tokens per answer · fast.",
  },
  reason: {
    measures: "Multi-step reasoning: keeping several quantities straight through a story and doing the arithmetic in order.",
    how: "40 word problems. Three people hold items, hand some over, one loses some, one doubles theirs, then everything is pooled and split into boxes. The question asks for two numbers: what is left over and what each box holds.",
    scoring: "The last line must be 'Answer: <left over>, <per box>' in the final answer (not the reasoning). Both numbers must be exactly right.",
    example: "Ana has 40 apples. Ben has 3 times as many as Ana. Cy has 12 … How many are in the jar, and how many in each box? End with 'Answer: <jar>, <per box>'.",
    settings: "Thinking on · up to 8192 tokens per answer · slower on thinking models.",
  },
  arith: {
    measures: "Exact arithmetic over a long chain, where one slip anywhere makes the final number wrong.",
    how: "40 chains: start from a 3-digit number and apply 10 operations in order (multiply, add, subtract, remainder then add 1000, divide rounding down). Every number stays a whole number.",
    scoring: "The last 'Answer: <number>' line must equal the true result (markdown and thousands commas are accepted).",
    example: "Start with 482. Then, in order: (1) multiply it by 7; (2) add 1530; … (10) divide it by 4, rounding down. What is the final number?",
    settings: "Thinking on · up to 12288 tokens per answer · slow.",
  },
  track: {
    measures: "Keeping state straight over a long sequence of small changes, like tracking variables through a program.",
    how: "40 stories with five people who each start with some tokens, followed by 25 events: gives some to another, finds a few, or gives half (rounded down). The question is how many tokens one person has at the end.",
    scoring: "The last 'Answer: <number>' line must be exactly right.",
    example: "Track the tokens carefully. Mia starts with 34 tokens. … Mia gives 5 to Leo. Leo finds 3. … How many tokens does Leo have at the end?",
    settings: "Thinking on · up to 12288 tokens per answer · slow.",
  },
  gsm8k: {
    measures: "Grade-school maths word problems, the public GSM8K benchmark, so results can be read next to published numbers (as an approximation, see below).",
    how: "200 problems drawn once, with a fixed seed, from the GSM8K test set (MIT-licensed). The model solves each step by step and ends with its answer.",
    scoring: "The last 'Answer: <number>' line (any capitalisation) must equal the dataset's final answer. $ signs, thousands commas, a % sign or a unit after the number (\"18 dollars\") are fine; a second value or a hedge is not.",
    example: "A real GSM8K problem, e.g. a shop-and-change or distance-and-time story, followed by “Solve it step by step. End with 'Answer: <number>'.”",
    settings: "Thinking on · up to 8192 tokens per answer. A sample of 200, not all 1,319, so a single score is only good to about ±4–7 points (95%); use the paired comparison for small differences, and do not compare with published GSM8K numbers.",
  },
  mmlu: {
    measures: "Broad knowledge and exam-style reasoning across 57 subjects (law, medicine, maths, history, computer science and more), the public MMLU benchmark.",
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
    how: "A long filler text with 16 “Remember this: the code for <animal> is <5 digits>” facts spread through it. Four of them are corrected near the end. The model is asked for the current code of every animal. You choose the context sizes (8k up to 256k) and how many items per size.",
    scoring: "Passes when all 16 latest codes are right. A code that was corrected but answered with its old value counts as stale.",
    example: "… Remember this: the code for otter is 48213. … Correction: the code for otter has changed, it is now 90471. … What is the current code for every animal?",
    settings: "Thinking off · sequential, one at a time · can take many minutes at large sizes, and sizes that do not fit the model's context are skipped.",
  },
};
