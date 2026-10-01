#!/usr/bin/env node
// Fails the build when dist/ does not actually correspond to src/.
//
// Why this exists, in the shape it was actually observed:
//
//   npm run build   →  tsc emits nothing (wrong outDir, a config that no longer
//                      includes src/, a toolchain that silently no-ops)
//   npm run build   →  prints its success banner and updates bin/manifest.json
//   grep dist/…     →  the new symbol is absent
//   conclusion      →  "the edit didn't compile"
//
// Nothing in the build chain noticed, because `&&` only catches a non-zero
// exit and tsc exiting 0 after emitting nothing is indistinguishable from
// tsc succeeding. So the last step re-derives the fact from disk: recomputes
// the src/ hash with the same function the build used and requires the stamp to
// match. A build that produced nothing fails here instead of shipping.
//
// This is a build-time gate, not a runtime one. src/buildStamp.ts's
// checkBuildFreshness is the runtime counterpart and covers the other half —
// dist/ being correct at build time and wrong by the time it runs.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(root, "dist");
const srcDir = join(root, "src");

const fail = (msg) => {
  console.error(`verify-build: ${msg}`);
  process.exit(1);
};

if (!existsSync(join(distDir, "index.js"))) {
  fail(`${distDir}/index.js does not exist — the build produced no entry point.`);
}

const stampPath = join(distDir, ".build-stamp.json");
if (!existsSync(stampPath)) {
  fail(
    `${stampPath} is missing. scripts/update-bin.mjs writes it at the end of a ` +
      `successful build; its absence means the build did not run to completion.`
  );
}

let stamp;
try {
  stamp = JSON.parse(readFileSync(stampPath, "utf8"));
} catch (err) {
  fail(`${stampPath} is not valid JSON: ${err?.message ?? err}`);
}
if (typeof stamp?.srcHash !== "string" || !/^[0-9a-f]{64}$/.test(stamp.srcHash)) {
  fail(`${stampPath} has no usable srcHash (got ${JSON.stringify(stamp?.srcHash)}).`);
}

// The same function the build used, loaded from the same place — recomputing
// with an independent implementation here would only prove the two agree with
// each other, which is a different and much weaker claim than "dist is current".
const { hashTree } = await import(pathToFileURL(join(distDir, "buildStamp.js")).href).catch((err) =>
  fail(`${distDir}/buildStamp.js could not be imported (${err?.message ?? err}) — the build did not emit its output.`)
);

const actual = hashTree(srcDir);
if (actual !== stamp.srcHash) {
  fail(
    `dist/ was built from a different src/ tree than the one on disk.\n` +
      `  stamped: ${stamp.srcHash}\n` +
      `  on disk: ${actual}\n` +
      `  src/ changed after the build, or tsc wrote somewhere other than dist/. ` +
      `Re-run \`npm run build\`.`
  );
}

console.log(`verify-build: ok (src ${actual.slice(0, 12)}…, ${stamp.gitSha?.slice(0, 7) ?? "unknown"})`);