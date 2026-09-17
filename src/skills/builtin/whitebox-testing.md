---
trigger: writing unit or integration tests with knowledge of the implementation's internals
---

# White-box testing

- Use knowledge of the implementation to target branches, not just happy
  paths: every conditional, loop boundary, error-handling branch, and early
  return should have a test that exercises it.
- Test boundary values explicitly: empty input, single element, off-by-one
  around loop/array bounds, min/max of numeric ranges, null/undefined where
  the type allows it.
- Don't test private implementation details that could change without
  changing behavior (internal variable names, call order that isn't
  observable). Test through the same interface a caller would use, informed
  by — but not coupled to — internals.
- One assertion focus per test where practical; a test with 10 unrelated
  assertions makes failures hard to diagnose.
- When you find a bug while implementing, write the regression test first
  (it should fail against the old code), then fix, then confirm it passes.
- Run the existing test suite after changes — a white-box change that
  breaks an unrelated test is telling you something about a hidden
  coupling; don't just delete the failing test to make it green.
