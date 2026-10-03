// Shared by the host runner and the container runner.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const loadMatrix = () => createRequire(join(here, "../../package.json"))("yaml").parse(readFileSync(join(here, "matrix.yaml"), "utf8"));

export function get(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
export function check(actual, want) {
  if (want && typeof want === "object" && !Array.isArray(want)) {
    if ("min" in want && !(actual >= want.min)) return `expected >= ${want.min}`;
    if ("max" in want && !(actual <= want.max)) return `expected <= ${want.max}`;
    return null;
  }
  if (Array.isArray(want)) return JSON.stringify(actual) === JSON.stringify(want) ? null : `expected ${JSON.stringify(want)}`;
  if (typeof want === "string" && /^\/.*\/$/.test(want)) return new RegExp(want.slice(1, -1)).test(String(actual)) ? null : `expected to match ${want}`;
  return actual === want || String(actual) === String(want) ? null : `expected ${JSON.stringify(want)}`;
}

