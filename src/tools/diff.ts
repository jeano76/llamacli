/** Line-based diff for showing file changes in the TUI (PROMPT.md §6:
 *  changes should be visible to the user, not just summarized in text). */

const ANSI = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

interface DiffOp {
  type: "add" | "del" | "ctx";
  line: string;
}

/** Classic O(n*m) LCS-based line diff. Files this tool edits are source
 *  files, not huge data dumps, so this is fine — but cap it defensively. */
function lcsDiff(oldLines: string[], newLines: string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > 4_000_000) {
    return [{ type: "ctx", line: `(diff skipped — file too large: ${n}x${m} lines)` }];
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: "ctx", line: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", line: oldLines[i] });
      i++;
    } else {
      ops.push({ type: "add", line: newLines[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", line: oldLines[i++] });
  while (j < m) ops.push({ type: "add", line: newLines[j++] });
  return ops;
}

/**
 * Renders a colored, context-trimmed diff as an ANSI string ready to print
 * directly to the terminal. Returns "" when there's no change.
 */
export function formatDiff(path: string, oldText: string, newText: string, contextLines = 3): string {
  if (oldText === newText) return "";
  const ops = lcsDiff(oldText.split("\n"), newText.split("\n"));

  const show = new Array(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op.type !== "ctx") {
      for (let k = Math.max(0, idx - contextLines); k <= Math.min(ops.length - 1, idx + contextLines); k++) {
        show[k] = true;
      }
    }
  });

  const lines: string[] = [`${ANSI.bold}--- ${path}${ANSI.reset}`];
  let prevShown = false;
  ops.forEach((op, idx) => {
    if (!show[idx]) {
      if (prevShown) lines.push(`${ANSI.gray}  ⋮${ANSI.reset}`);
      prevShown = false;
      return;
    }
    prevShown = true;
    if (op.type === "add") lines.push(`${ANSI.green}+ ${op.line}${ANSI.reset}`);
    else if (op.type === "del") lines.push(`${ANSI.red}- ${op.line}${ANSI.reset}`);
    else lines.push(`${ANSI.gray}  ${op.line}${ANSI.reset}`);
  });
  return lines.join("\n");
}
