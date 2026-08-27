import type { TKey } from "../../i18n/en";

/**
 * Shipped presets.
 *
 * Every body here is OUR text. The source material cannot be shipped as-is:
 * `02_cc_prompt.md` is a Korean analysis document ABOUT Claude Code's prompt
 * rather than the prompt, `02_gr_prompt.md` mixes OSS findings with a
 * binary-analysis appendix and carries unresolved `${{ tools.by_kind.* }}`
 * placeholders, and Grok Build's real templates open with "You are Grok" and
 * rely on render-time expansion only MiniJinja performs.
 *
 * So each preset distills behavioral INTENT into harness-neutral wording and
 * carries a provenance line naming its source as an adaptation. No verbatim
 * third-party prompt enters this repository, which also keeps the licensing
 * question from ever arising.
 *
 * Every body is a behavioral instruction. None names a tool, claims an identity,
 * or describes the environment - which is what makes them safe to append, and
 * exactly the constraint the linter enforces. A preset that tripped its own
 * linter would be worse than shipping none, so a test lints all of them.
 *
 * Bodies stay English. They are instructions to a model, not UI copy, and a
 * mistranslated behavioral directive is a functional defect. The Korean-replies
 * preset is the exception that proves it: its body is English text instructing
 * Korean output.
 */
export interface Preset {
  id: string;
  nameKey: TKey;
  descriptionKey: TKey;
  /** Names the source and states that this is an adaptation, never a copy. */
  provenanceKey: TKey;
  body: string;
}

export const PRESETS: readonly Preset[] = Object.freeze([
  {
    id: "concise",
    nameKey: "codexSet.preset.concise.name",
    descriptionKey: "codexSet.preset.concise.description",
    provenanceKey: "codexSet.preset.concise.provenance",
    body: [
      // Phrased to avoid "you are" entirely: an identity-shaped fragment inside an
      // otherwise behavioral instruction is exactly what the linter watches for, and
      // a preset that trips our own rules would be worse than shipping none.
      "Answer directly. Skip preamble, restatement of the question, and summaries of the work about to be done.",
      "Prefer a short paragraph over a list, and a list over a table, unless the structure carries real meaning.",
      "When the answer is a single fact, give the fact and stop.",
    ].join("\n"),
  },
  {
    id: "plan-first",
    nameKey: "codexSet.preset.planFirst.name",
    descriptionKey: "codexSet.preset.planFirst.description",
    provenanceKey: "codexSet.preset.planFirst.provenance",
    body: [
      "Before changing anything non-trivial, state the plan in two or three sentences: what will change, where, and how it will be verified.",
      "If the plan turns out to be wrong mid-way, say so and revise it rather than continuing quietly.",
    ].join("\n"),
  },
  {
    id: "explain-why",
    nameKey: "codexSet.preset.explainWhy.name",
    descriptionKey: "codexSet.preset.explainWhy.description",
    provenanceKey: "codexSet.preset.explainWhy.provenance",
    body: [
      "When a choice had alternatives, name the alternative and why it lost.",
      "Explain reasoning where it changes what the reader should do, not as a narration of every step.",
      "State uncertainty plainly instead of presenting a guess as a conclusion.",
    ].join("\n"),
  },
  {
    id: "test-first",
    nameKey: "codexSet.preset.testFirst.name",
    descriptionKey: "codexSet.preset.testFirst.description",
    provenanceKey: "codexSet.preset.testFirst.provenance",
    body: [
      "For a behavior change, write the failing test first and show that it fails for the expected reason.",
      "A test that passes before the change is not evidence; say so rather than counting it.",
    ].join("\n"),
  },
  {
    id: "korean",
    nameKey: "codexSet.preset.korean.name",
    descriptionKey: "codexSet.preset.korean.description",
    provenanceKey: "codexSet.preset.korean.provenance",
    // English text instructing Korean output: the body is an instruction to a
    // model, so it stays in the language the rest of the stack is written in.
    body: [
      "Reply in Korean regardless of the language of the request, unless explicitly asked for another language.",
      "Keep code, identifiers, file paths, and command output unchanged.",
      "Write plain Korean: no translationese, one consistent register throughout.",
    ].join("\n"),
  },
]);
