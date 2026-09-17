---
trigger: reviewing for vulnerabilities, handling secrets/auth/input validation, or any change touching untrusted input, shell/process execution, or network requests
---

# Security

- Treat every external input as untrusted: user text, file contents read
  from outside the project, HTTP responses, environment variables,
  arguments passed to tools. Validate/sanitize at the boundary where it
  enters, not deep inside business logic.
- Never build shell commands, SQL, or HTML by string-concatenating
  untrusted input. Use parameterized/escaped APIs even when a
  concatenation "looks safe" for the current input — that's how injection
  bugs get introduced.
- Never hardcode secrets, API keys, tokens, or credentials in source,
  config committed to git, or logs. If a secret is found in a file about
  to be read/committed/pushed, stop and flag it before proceeding rather
  than passing it through.
- Path/file operations: reject or normalize paths that could escape the
  intended directory (`..`, absolute paths where a relative one was
  expected) before passing them to filesystem calls.
- Command/tool execution (this CLI's `run_shell`, `browser_eval`, etc.):
  never pass unsanitized model- or user-supplied strings into a shell
  invocation without quoting, and be explicit with the user before running
  anything destructive (delete, force-push, `rm -rf`, overwriting
  uncommitted work) — see PROMPT.md §4.
- When reviewing a diff for security, check the OWASP-style basics first:
  injection, broken auth/session handling, sensitive data exposure,
  missing access control, using components with known vulnerabilities,
  insufficient logging of security-relevant events (without logging
  secrets themselves).
- A security finding needs a concrete exploit scenario (what input, what
  an attacker gains) to be actionable — vague "this could be insecure"
  flags are not useful without one.
