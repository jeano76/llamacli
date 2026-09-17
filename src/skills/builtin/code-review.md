---
trigger: user asks to review code, a diff, or a pull request
---

# Code review

- Read the diff in the context of the surrounding file, not in isolation —
  a correct-looking hunk can still break an invariant the rest of the file
  depends on.
- Rank findings by actual impact: correctness bugs and security issues
  first, then missing test coverage for changed behavior, then
  maintainability. Style nits last, and only if they're not already
  handled by a linter/formatter.
- For every finding, state the concrete failure scenario (what input or
  sequence of calls breaks it), not just "this looks risky". A finding
  without a failure scenario is a guess, not a review comment.
- Check what changed AND what didn't: did the diff forget to update a
  caller, a type, a test, or documentation that assumed the old behavior?
- Don't nitpick style that a formatter/linter would already catch, and
  don't request changes outside the diff's stated scope — flag those
  separately as "not blocking this change" if worth mentioning at all.
- If nothing significant is wrong, say so plainly — don't manufacture
  findings to seem thorough.
