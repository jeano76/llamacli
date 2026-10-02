/**
 * One log row that is REDRAWN rather than appended.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * A long download reported through the normal log appends a row per update. A
 * 20 GB transfer emits hundreds, and past `MAX_LOG_ENTRIES` the setup output the
 * user needed is pushed off the top of the visible log long before the bytes
 * arrive. The bar was never the problem — it was being APPENDED instead of
 * REDRAWN, which is the difference between a status readout and a log.
 *
 * A pure reducer over a plain array, so it is testable without mounting Ink AND
 * so `App.tsx` and its test cannot drift apart. An earlier version of the test
 * re-implemented this logic inside the test file, which meant it would have
 * passed no matter what the app actually did — precisely the defect this module
 * exists to make impossible.
 */

export interface TransientRow {
  id: number;
  text: string;
}

export interface TransientLine<T extends TransientRow> {
  /** Replace the current row's content, creating it if there is none. */
  update(text: string): void;
  /**
   * Release the slot so the next `update` starts a new row. The row itself stays
   * in the log, which is what leaves a record of a finished transfer.
   */
  end(): void;
}

/**
 * @param commit builds a stored row from the text. Generic over the row type so
 *   the caller keeps its own fields (App.tsx needs `kind`).
 * @param nextId id allocator owned by the LOG, so this can never mint an id the
 *   log already used — a collision would make the bar rewrite an unrelated row.
 * @param maxRows the log's cap. When the cap is hit mid-transfer the live row
 *   can be trimmed away, so it is RE-ADDED rather than abandoned: an abandoned
 *   id means every later update is a no-op and the bar freezes at some
 *   arbitrary percentage, which reads as a stalled download.
 */
export function createTransientLine<T extends TransientRow>(
  get: () => T[],
  set: (next: T[]) => void,
  commit: (text: string) => T,
  nextId: () => number,
  maxRows: number
): TransientLine<T> {
  let transientId: number | null = null;

  return {
    update(text) {
      const rows = get();
      if (transientId === null) {
        // The id MUST be stamped on the row that goes in. Leaving `commit`'s own
        // placeholder id in place is a bug the tests caught immediately: the row
        // was stored under a different id than the one held here, so every
        // subsequent update failed to find it, took the "trimmed away" path, and
        // appended. The symptom was a bar that grew the log anyway -- the exact
        // thing this module exists to prevent, from a cause three lines away.
        transientId = nextId();
        set([...rows, { ...commit(text), id: transientId } as T].slice(-maxRows));
        return;
      }
      const at = rows.findIndex((r) => r.id === transientId);
      if (at === -1) {
        set([...rows, { ...commit(text), id: transientId } as T].slice(-maxRows));
        return;
      }
      const next = rows.slice();
      next[at] = { ...next[at], text };
      set(next);
    },
    end() {
      transientId = null;
    },
  };
}
