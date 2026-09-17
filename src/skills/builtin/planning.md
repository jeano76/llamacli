---
trigger: user asks to plan a task before implementing, or the task spans multiple files/steps and needs a breakdown first
---

# Planning

- Restate the goal in one sentence before breaking it down. If you can't,
  the request is still ambiguous — ask or make the narrowest reasonable
  assumption and say so.
- Break the work into steps that are each independently verifiable (you can
  tell if a step succeeded without finishing the whole task). Vague steps
  like "improve X" are not plannable — make them concrete.
- Identify the riskiest/least-certain step and do it first or investigate it
  first. Don't leave the biggest unknown for last.
- Declare the plan via the update_plan tool so it survives context
  compaction (PROMPT.md §2) — update each step's status as you go rather
  than silently completing steps without recording them.
- Scope check: does every step trace back to the original request? Drop
  steps that don't — planning is also where scope creep is cheapest to
  catch, before any code is written.
