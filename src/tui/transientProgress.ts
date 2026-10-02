import { formatProgress, type TransferProgress } from "../setup/download.js";

/** What the UI exposes for a redrawn row. */
export interface TransientUi {
  setTransient?: (text: string) => void;
}

/**
 * The `onProgress` factory the TUI hands to the bootstrap: every update REDRAWS the one
 * transient row.
 *
 * It must never release the row (`endTransient`) between updates. That was the bug: each
 * update was preceded by `endTransient()`, which hands the current row to the scrollback
 * and makes the next `setTransient` start a NEW row — so a 20 GB download appended one
 * row per update and scrolled the whole log. Releasing belongs once, after the transfer.
 */
export function transientProgress(ui: () => TransientUi | undefined) {
  return (_defaultReporter: (p: TransferProgress) => void) => (p: TransferProgress) => {
    ui()?.setTransient?.(formatProgress(p));
  };
}
