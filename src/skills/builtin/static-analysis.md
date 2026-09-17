---
trigger: user asks to run or set up linting, type checking, or static analysis tooling
---

# Static analysis

- Run the project's existing type checker/linter before claiming a change
  is done — don't rely on visual inspection alone when tooling exists
  (e.g. this project: `npm run typecheck`).
- Treat a type error as a real defect to fix at the source, not a signal to
  weaken types (`any`, non-null assertions, `@ts-ignore`) unless the
  underlying type is genuinely wrong and you're correcting it.
- When adding a new static analysis tool to a project, start it in
  report-only/warn mode on the existing codebase first — don't block CI on
  a fresh tool before triaging its baseline findings, or every unrelated PR
  eats pre-existing debt.
- Prioritize findings by class: type errors and null-safety issues first
  (they represent real runtime bugs), then unused code/dead branches, then
  style. Don't let a wall of style warnings bury a real bug.
- A clean static-analysis pass is necessary but not sufficient — it doesn't
  replace tests or review, only removes a class of bugs those methods are
  bad at catching cheaply.
