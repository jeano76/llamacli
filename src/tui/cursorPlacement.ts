/**
 * Where the real terminal cursor belongs, shared between the component that
 * computes it and the stdout wrapper that has to re-assert it.
 *
 * ── The bug this exists to fix ───────────────────────────────────────────────
 * Reported directly: "프롬프트 창에 문자를 적고 있으면 마지막 커서가 하단 최좌측
 * 으로 나타나는 경우가 있어" — while typing, the cursor sometimes appears in
 * the bottom-left corner of the screen.
 *
 * The cause is an ordering fact about Ink 4, verified by reading
 * node_modules/ink/build/reconciler.js and by driving the real app:
 *
 *   1. React commits → the reconciler calls `rootNode.onRender()`, which Ink
 *      wraps in `throttle(this.onRender, 32, {leading: true, trailing: true})`
 *      (ink.js). That throttled call is what actually writes the frame.
 *   2. App's `useEffect` then writes the cursor-placement escape sequence.
 *
 * On the *leading* edge that order is fine. But a throttle with `trailing: true`
 * also fires up to 32 ms LATER, after the effect has run — and that frame
 * repaints the screen and leaves the real cursor wherever the frame's last
 * written character ended, which is the bottom-left of the alt screen. So the
 * correctly-placed cursor is overwritten by a repaint that nobody asked to
 * re-place it.
 *
 * The pre-existing 400 ms self-heal interval could not cover this: it bounds
 * the drift at up to 400 ms of the cursor being visibly wrong, and it re-writes
 * unconditionally, which on its own is a steady stream of writes. Also note
 * Ink's `render(..., {onRender})` option is NOT called at all in 4.4.1 (only
 * `debug` mode uses the user's callback), so there is no supported post-paint
 * hook to hang a fix on.
 *
 * The fix therefore has to be at the layer that actually writes: index.tsx
 * passes Ink a wrapped stdout whose `write` re-appends the placement after
 * every frame. That makes the placement unconditional — correct for leading,
 * trailing, throttled, and CI paths alike — and lets the 400 ms self-heal be
 * removed rather than merely shortened.
 */

let placement: string | null = null;

/** Records the sequence that puts the real cursor where the prompt is. Called
 *  by App on every render. A null/empty sequence (no alt screen, nothing to
 *  place) disables the re-assertion entirely. */
export function setCursorPlacement(seq: string | null): void {
  placement = seq && seq.length > 0 ? seq : null;
}

export function getCursorPlacement(): string | null {
  return placement;
}

/** Clears the placement — used when the app unmounts, so a wrapper left
 *  attached to stdout can't keep writing an escape sequence for a dead app. */
export function clearCursorPlacement(): void {
  placement = null;
}
