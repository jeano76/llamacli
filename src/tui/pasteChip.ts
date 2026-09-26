/**
 * Requested directly: "복사넣기를 할 때 평문을 그대로 넣지 말고 claude cli
 * 같은 곳에서 하는 것처럼 파일은 경로명 그리고 텍스트는 [복사된 바이트
 * 정보 와 라인길이] 형태로 표시를 해서 프롬프트 영역이지만 글씨처럼
 * 수정은 되지 않게 해줘 삭제 백키를 누르면 전체가 하나의 문자 처럼
 * 삭제가 되는거야 그리고 프롬프트를 전달할 때는 결국 복사된 내용이
 * 일반 text 로 전달이 되는거야"
 *
 * The input box's `input` state stays a single string (it always has —
 * there's no cursor-in-the-middle editing anywhere in this file, only
 * append/backspace-from-the-end), but a pasted block is appended as a
 * short PLACEHOLDER label instead of the raw text, and the real content
 * is kept alongside in a separate `pastedBlocks` map (label -> real
 * content) in App.tsx. That map is what makes the placeholder act like
 * one atomic character: a single backspace removes the whole label (see
 * findTrailingPlaceholder), and substitutePlaceholders() swaps every
 * label back for its real content right before the prompt is actually
 * sent — the model always receives the real pasted text, never the label.
 */

/** Below this length, a single Ink `useInput` callback firing with more
 *  than one character is almost certainly just a burst of a few fast
 *  keystrokes landing in the same read (common typing Hangul or typing
 *  quickly in general) batched together by the terminal, not an actual
 *  clipboard paste — so it's left as plain literal text rather than
 *  wrapped in a placeholder that would be more distracting than useful
 *  for something this short anyway. */
export const PASTE_LENGTH_THRESHOLD = 6;

export function isLikelyPaste(text: string): boolean {
  return text.length >= PASTE_LENGTH_THRESHOLD;
}

/** A real file path pasted in one piece (e.g. dragged into the terminal,
 *  or copied via a file manager's "copy path") is always a single line
 *  and rarely more than a normal path's worth of characters — anything
 *  bigger or multi-line is real pasted text content, not a path, even if
 *  by sheer coincidence a file with that exact (very long) name existed.
 *  Callers still need to confirm it actually exists on disk (fs access is
 *  deliberately kept out of this pure function so it stays unit-testable
 *  without a real filesystem). */
export function looksLikePastedFilePath(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0 || trimmed.length > 4096) return false;
  return !trimmed.includes("\n");
}

/** `counter` guarantees the label can never collide with anything a user
 *  could plausibly type by hand, regardless of what's in `content` — two
 *  pastes of the exact same text still get visibly distinct labels. */
export function formatPasteLabel(content: string, counter: number, isPath: boolean): string {
  if (isPath) {
    return `[파일 #${counter}: ${content.trim()}]`;
  }
  const lines = content.split("\n").length;
  const bytes = Buffer.byteLength(content, "utf8");
  return `[붙여넣기 #${counter}: ${lines}줄, ${bytes}바이트]`;
}

/** Returns the placeholder label `input` currently ends with, if any —
 *  the one thing a single backspace press needs to know in order to
 *  delete an entire pasted block atomically instead of one character at
 *  a time. `undefined` when `input` doesn't end in a still-tracked
 *  placeholder (ordinary typed text, or a placeholder already removed). */
export function findTrailingPlaceholder(input: string, pastedBlocks: ReadonlyMap<string, string>): string | undefined {
  for (const label of pastedBlocks.keys()) {
    if (label.length > 0 && input.endsWith(label)) return label;
  }
  return undefined;
}

/** Swaps every still-tracked placeholder label in `input` for its real
 *  pasted content — this is what actually gets sent to the model /
 *  saved to prompt history, never the label itself. Plain `split/join`
 *  rather than a regex replace: labels are opaque literal strings that
 *  may themselves contain regex metacharacters (a pasted path with
 *  brackets, say), so treating them as a regex pattern would be wrong. */
export function substitutePlaceholders(input: string, pastedBlocks: ReadonlyMap<string, string>): string {
  let resolved = input;
  for (const [label, content] of pastedBlocks) {
    if (resolved.includes(label)) resolved = resolved.split(label).join(content);
  }
  return resolved;
}
