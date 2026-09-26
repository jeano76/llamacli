## 2026-09-25T12:35:29.585Z

"run_shell" failed with the same pattern 18 times. Proposing a new rule.

# Long `sleep` polling in `run_shell`

`run_shell` enforces a command timeout; any command embedding a long `sleep N` (e.g. `sleep 120`) will hit that timeout and fail identically on every retry.

Do **not** use `sleep` to wait for a background install/job to finish. Instead:

- Launch the job once with `nohup ... &` (or a background task) and record its PID.
- Poll quickly and non-blocking with a short timeout using `pgrep -f` / `ps` and `grep DONE_EXIT` on the log, checking every few seconds rather than sleeping.
- Exit the loop the moment the completion marker appears, and only `tail` the log after the job is confirmed finished.

If the process is still running, return control and check again; never block inside a single `run_shell` call.

---

## 2026-09-25T14:21:25.745Z

"edit_file" failed with the same pattern 3 times. Proposing a new rule.

# edit_file old_text not found

Before editing a file, always read its current content with `view` to confirm the exact bytes present. Use a short, unique, verifiable snippet as `old_text` — never guessed or paraphrased text, and avoid ambiguous matches that could span multiple locations. If no suitable anchor exists, use `write_file` instead. Retract and re-check if a previous edit in the same session already changed the region.

---

## 2026-09-26T02:52:05.207Z

"compact" failed with the same pattern 37 times. Proposing a new rule.

# Compact tool timeouts

The `compact` tool timed out after 120000ms on repeated calls.

- Only compact when the context is large enough to justify it; do not trigger compaction prematurely.
- Keep the text passed to `compact` small and focused — summarize incrementally rather than pasting huge blocks at once.
- If the pending conversation is very large, compact in stages instead of a single massive call.
- Ensure a completion message is sent so the context is idle before invoking `compact`.
- Never fire multiple compactions concurrently or back-to-back while one is still running.

---

## 2026-09-26T06:32:19.889Z

"compact" failed with the same pattern 6 times. Proposing a new rule.

# Compaction Chat Timeout (120000ms)

The `compact` tool repeatedly timed out at 120s because it was asked to summarize conversations exceeding the model's context window in a single pass.

- Do not call `compact` when the active conversation already exceeds ~75% of the model's context limit; instead split work into a fresh session first.
- Trigger compaction proactively on sustained growth rather than letting the transcript grow unbounded.
- Keep the instruction passed to `compact` focused and bounded, requesting only the essential summary and open tasks, not a verbatim transcript.
- If the system indicates the pending summary would be very long, call the tool incrementally instead of awaiting one large summarization.

---

## 2026-09-26T13:27:32.343Z

"compact" failed with the same pattern 16 times. Proposing a new rule.

# Avoid Compaction Chat Timeouts

Repeated `compact` calls failing with "chat timed out after 120000ms" usually mean the compaction prompt is too large to generate within the deadline.

- Cap the context fed to the compaction model; summarize incrementally rather than re-sending the full transcript each round.
- Keep the compaction instruction minimal and avoid multi-step reasoning prompts.
- If a compaction call is near the timeout, reduce input size or split the work instead of retrying the same large call.
- Never queue back-to-back compactions; let each finish before starting the next.

---

