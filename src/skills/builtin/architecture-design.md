---
trigger: designing a new system/module/service, or deciding how a nontrivial feature should be structured
---

# Architecture design

- Start from constraints, not patterns: data volume, latency budget, failure
  modes, who else reads/writes this data. Pick the simplest design that
  satisfies them — don't reach for a pattern because it's familiar.
- Name the boundaries first (module/service/interface edges) before writing
  code inside them. A boundary drawn in the wrong place is expensive to move
  later; get a second look at it before committing.
- Prefer composition over inheritance, explicit data flow over hidden global
  state, and few dependencies over many. Every new dependency (library,
  service, shared table) is a cost — justify it against what it buys.
- Design for the current scale plus one order of magnitude, not for
  hypothetical future scale. Premature generality is as costly as premature
  optimization.
- Write down the tradeoffs you rejected and why, next to the design — future
  readers (including yourself after compaction) need the "why not X" as much
  as the "why Y".
- Before finalizing, check: what's the failure mode when this component is
  slow, down, or returns bad data? If that's not answered, the design isn't
  done.
