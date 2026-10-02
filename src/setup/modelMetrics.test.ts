import { test } from "node:test";
import assert from "node:assert/strict";
import stringWidth from "string-width";
import {
  MODEL_RUNGS,
  evaluateFit,
  evaluateAll,
  findRung,
  formatModelTable,
  usableVramGiB,
  type ModelRung,
} from "./modelMetrics.js";
import type { Hardware } from "./hardware.js";

const GiB = 1024 ** 3;

function hw(o: { cpus: number; ramGiB: number; vramGiB?: number }): Hardware {
  return {
    cpuCount: o.cpus,
    ramTotalBytes: o.ramGiB * GiB,
    ramAvailableBytes: o.ramGiB * GiB,
    gpus: o.vramGiB ? [{ index: 0, name: "test", vramTotalBytes: o.vramGiB * GiB, vramFreeBytes: o.vramGiB * GiB }] : [],
    gpuBackend: o.vramGiB ? "cuda" : "none",
    canBuildCuda: Boolean(o.vramGiB),
    tools: {},
    platform: "linux",
  } as Hardware;
}

// The real box: RTX 2070 SUPER 8 GB, 30 GB RAM, 12 cores.
const profileA = hw({ cpus: 12, ramGiB: 30, vramGiB: 8 });

test("the 35B MoE rung runs on an 8 GB card by streaming experts from RAM", () => {
  // This is the case the whole feature exists to make legible: 21.9 GiB of
  // weights on a card with 8 GiB. It runs because only the active ~3B are
  // resident — so the answer must be "stream", not "no".
  const r = evaluateFit(findRung("ornith-35b")!, profileA);
  assert.equal(r.fit, "stream", `expected stream, got ${r.fit}: ${r.verdict}`);
  assert.match(r.verdict, /RAM/, "the verdict should say where the experts come from");
});

test("a small dense rung fits entirely in VRAM and gets a context estimate", () => {
  const r = evaluateFit(findRung("bonsai-4b")!, profileA);
  assert.equal(r.fit, "vram", `expected vram, got ${r.fit}: ${r.verdict}`);
  assert.ok(r.maxContext! >= 4096, `context ${r.maxContext} should be usable`);
  assert.ok(r.maxContext! <= 32768, `context ${r.maxContext} must stay inside llama.cpp's range`);
});

test("an 80 GB card fully offloads the 35B", () => {
  const big = hw({ cpus: 32, ramGiB: 64, vramGiB: 80 });
  const r = evaluateFit(findRung("ornith-35b")!, big);
  assert.equal(r.fit, "vram", `expected vram on an 80 GB card, got ${r.fit}`);
});

test("MoE residency saves VRAM but never invents RAM", () => {
  // The MoE advantage is real but it is bounded, and the bound is RAM: streaming
  // experts still needs somewhere to stream them FROM. On a 4 GB card with 8 GB
  // of RAM the 21.9 GiB 35B-A3B does NOT run, while the 5.5 GiB dense 27B
  // does — smaller wins, which is the correct and slightly counter-intuitive
  // answer. An earlier version of this test assumed MoE always survives.
  const small = hw({ cpus: 4, ramGiB: 8, vramGiB: 4 });
  const fits = evaluateAll(small);
  const moe = fits.find((f) => f.rung.id === "ornith-35b")!;
  const dense27 = fits.find((f) => f.rung.id === "bonsai-27b")!;
  assert.equal(moe.fit, "no", "20.4 GiB of weights cannot stream from 8 GiB of RAM");
  assert.equal(dense27.fit, "ram", "the smaller dense model fits in RAM even though the MoE one does not");

  // And with RAM to match, the MoE rung is back — that is the case it is for.
  const roomy = hw({ cpus: 8, ramGiB: 32, vramGiB: 4 });
  assert.equal(evaluateFit(findRung("ornith-35b")!, roomy).fit, "stream");
});

test("a model that fits nowhere is reported as not runnable, not as runnable-slow", () => {
  const tiny = hw({ cpus: 1, ramGiB: 2, vramGiB: 1 });
  const r = evaluateFit(findRung("ornith-35b")!, tiny);
  assert.equal(r.fit, "no");
  assert.match(r.verdict, /실행되지 않습니다/);
});

test("every rung is ordered largest first, so scanning compares by cost", () => {
  const sizes = MODEL_RUNGS.map((r) => r.sizeBytes);
  for (let i = 1; i < sizes.length; i++) {
    assert.ok(sizes[i] <= sizes[i - 1], `rung ${i} (${MODEL_RUNGS[i].id}) is larger than the one above it`);
  }
});

test("the VRAM budget holds a reserve rather than planning against the full card", () => {
  // gnome-shell holds ~150 MiB on this box; planning against the full 8 GiB is
  // what produces a model that OOMs two seconds into loading.
  const budget = usableVramGiB(profileA);
  assert.ok(budget < 8, `budget ${budget} must be under the card's 8 GiB`);
  assert.ok(budget > 5, `budget ${budget} must not be so conservative that nothing fits`);
});

test("every rung evaluates to a verdict with real words, never an empty one", () => {
  for (const machine of [profileA, hw({ cpus: 8, ramGiB: 16 }), hw({ cpus: 2, ramGiB: 4, vramGiB: 2 })]) {
    for (const r of evaluateAll(machine)) {
      assert.ok(r.verdict.trim().length > 10, `${r.rung.id}: verdict is too short to be useful`);
      assert.ok(r.verdict.includes("GiB"), `${r.rung.id}: verdict should carry the numbers it is deciding on`);
    }
  }
});

test("findRung accepts the id or the label, case-insensitively", () => {
  assert.equal(findRung("ORNITH-35B")?.id, "ornith-35b");
  assert.equal(findRung("  bonsai-4b  ")?.id, "bonsai-4b");
  assert.equal(findRung("ornith-1.5-35b-a3b")?.id, "ornith-35b");
  assert.equal(findRung("nope"), undefined);
});

test("every column starts at the same DISPLAY offset on every row", () => {
  // Rows are trimmed at the right (a log line should not carry trailing
  // spaces), so total widths differ by design. What must line up is where each
  // COLUMN begins, and that has to be measured in display columns: Korean labels
  // are two columns per glyph while the ASCII columns are one, so measuring with
  // .length puts every column after the first one off by the number of Korean
  // characters in it.
  const { lines } = formatModelTable(evaluateAll(profileA));
  // The separator row is one uninterrupted run of box-drawing characters, so its
  // length is the table's full display width.
  const fullWidth = stringWidth(lines[1]);
  for (const [i, l] of lines.entries()) {
    assert.ok(stringWidth(l) <= fullWidth, `row ${i} is wider than the table: ${stringWidth(l)} > ${fullWidth}`);
    assert.ok(l.trim().length > 0, "no blank rows in the table");
    assert.doesNotMatch(l, /undefined|NaN/, `table cell is empty-ish: ${l}`);
  }
  // The real check: every data row starts with its own index, so the index
  // column has one width and every later column lines up behind it.
  const dataRows = lines.slice(2);
  dataRows.forEach((l, i) => {
    assert.ok(l.startsWith(`${i + 1} `), `row ${i + 1} does not start with its index: ${JSON.stringify(l.slice(0, 6))}`);
  });
});

test("the numbers the table prints are the numbers selection uses", () => {
  // Deriving the label and the index separately is how "/models 3" ends up
  // selecting a different row than the one the user was shown as 3.
  const reports = evaluateAll(profileA);
  const { lines, numbers } = formatModelTable(reports);
  assert.equal(numbers.length, reports.length);
  reports.forEach((r, i) => {
    assert.equal(numbers[i], i + 1);
    assert.ok(lines[i + 2].startsWith(`${i + 1} `), `row ${i + 1} does not start with its own number: ${lines[i + 2]}`);
  });
});

test("a synthetic rung is measured the same way as a real one", () => {
  // Guards the maths independently of the catalogue contents.
  const giant: ModelRung = {
    id: "giant", label: "가상의 초대형 모델", params: "400B", quant: "Q4_K_M",
    sizeBytes: 200 * GiB, repo: "x/y",
  };
  assert.equal(evaluateFit(giant, profileA).fit, "no");
  const tinyRung: ModelRung = { ...giant, sizeBytes: 500 * 1024 * 1024 };
  assert.equal(evaluateFit(tinyRung, profileA).fit, "vram");
});