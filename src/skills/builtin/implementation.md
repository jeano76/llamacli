---
trigger: actively writing or editing code to implement a planned change
---

# Implementation

- Read the surrounding code before editing it. Match existing naming,
  formatting, and error-handling conventions — don't introduce a second
  style in the same file.
- Make the smallest diff that correctly implements the request. No
  drive-by refactors, no unrequested abstractions, no speculative
  parameters "for later".
- Prefer editing an existing file over creating a new one. Only add a new
  file when the existing structure genuinely has nowhere for this to go.
- Don't add error handling, retries, or validation for inputs that can't
  actually occur given the caller. Trust internal invariants; validate only
  at real boundaries (user input, external APIs, file/network I/O).
- Never hardcode secrets, API keys, or credentials. Never introduce
  injection surfaces (string-concatenated shell commands, SQL, unescaped
  HTML) — use the safe/parameterized form even if it's a few characters
  longer.
- After a change compiles/runs, re-read the diff once as if reviewing
  someone else's PR before calling it done.
