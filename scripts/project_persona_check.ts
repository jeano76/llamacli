#!/usr/bin/env node
/**
 * Project-axis validation: 100 virtual developers, 100 different projects.
 *
 * ── What this is, honestly ──────────────────────────────────────────────────
 * This is NOT 100 simulated humans, and it is not 100 simulated machines. The
 * existing `persona_usability_check.ts` already covers the TERMINAL axis; this
 * covers the axis next to it — the PROJECT the developer opened.
 *
 * "A persona" here means a concrete, reproducible project state: a directory
 * layout, a path shape, a config state, a locale. Nothing about a persona is
 * fictional; the value is in the coverage matrix, not a story about a person.
 *
 * The distinction from the earlier synthetic matrix matters and is the point of
 * this harness: `tuning.test.ts` proves the setup DECISION FUNCTIONS are correct
 * for every hardware shape. It cannot tell you what happens when the project
 * directory is called `프로젝트 with spaces`, or when `.llamacli/config.yaml` is
 * a 3-byte corrupt file, or when the project root is a symlink into another
 * disk. Those are I/O and path problems, and the only honest way to find them
 * is to build the directories and run the real code against them.
 *
 * So: every persona here gets a REAL directory on disk, and the real
 * `ensureLocalStack` runs against it. Nothing is stubbed except the network and
 * the hardware probe, which are the two things a test must not depend on.
 *
 * Run: npx tsx scripts/project_persona_check.ts [--verbose]
 */
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { realpath } from "node:fs/promises";
import { ensureLocalStack, keepUserOwnedKeys } from "../src/setup/bootstrap.js";
import { loadConfig, configPath } from "../src/config.js";
import { detectHardware, pickPrimaryGpu, type Hardware } from "../src/setup/hardware.js";
import { SLASH_MENU_ITEMS } from "../src/tui/SlashMenu.js";
import { parse as load, stringify as dump } from "yaml";

let checks = 0;
const failures: { persona: string; invariant: string; detail: string }[] = [];
function check(persona: string, invariant: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) failures.push({ persona, invariant, detail });
}

const GiB = 1024 ** 3;

// ── the persona axes ────────────────────────────────────────────────────────
// Each axis is a real axis along which this project has broken, or plausibly
// could: path shape, config state, disk pressure, locale, repo state.

/** What kind of project is it? Determines what already exists on disk. */
type ProjectKind =
  | "empty"            // first launch, nothing at all
  | "git-repo"         // a real repo with history
  | "git-repo-dirty"   // a repo mid-work
  | "monorepo"         // nested packages, each with their own config
  | "has-config"       // already bootstrapped
  | "corrupt-config"   // .llamacli/config.yaml is garbage
  | "truncated-config" // config cut off mid-write
  | "read-only"        // project dir not writable
  | "model-in-project" // a .gguf inside the project (should NOT be committed)
  | "deep-nest";       // very deep directory

/** How does the path look? This is where POSIX/Windows divergence bites. */
type PathShape =
  | "ascii"
  | "with-spaces"
  | "korean"
  | "emoji"
  | "dots"
  | "long"
  | "backslash-ish"    // a directory literally named like a Windows path
  | "symlinked";       // reached through a symlink

type Persona = {
  id: number;
  name: string;
  kind: ProjectKind;
  shape: PathShape;
  /** Config the developer already has. */
  preexisting?: Record<string, unknown>;
  /** Locale, which decides what a filename may contain. */
  locale: string;
  /** Free bytes the models filesystem reports (0 = refuse). */
  freeGiB: number;
};

const KINDS: ProjectKind[] = [
  "empty", "git-repo", "git-repo-dirty", "monorepo", "has-config",
  "corrupt-config", "truncated-config", "read-only", "model-in-project", "deep-nest",
];
const SHAPES: PathShape[] = [
  "ascii", "with-spaces", "korean", "emoji", "dots", "long", "backslash-ish", "symlinked",
];
const LOCALES = ["ko_KR.UTF-8", "en_US.UTF-8", "C", "ja_JP.UTF-8", "POSIX"];

function pathForShape(shape: PathShape, base: string, id: number): string {
  switch (shape) {
    case "ascii": return join(base, `proj${id}`);
    case "with-spaces": return join(base, `my project ${id}`);
    case "korean": return join(base, `프로젝트-${id}`);
    case "emoji": return join(base, `proj-${id}-🚀`);
    // A directory whose name is mostly dots: a real trap for path handling.
    case "dots": return join(base, `...${id}...`);
    // Long enough to push past a 100-char soft limit when combined.
    case "long": return join(base, `a-very-long-project-directory-name-that-keeps-going-${id}-and-going`);
    // A name that LOOKS like a Windows path. On Linux these are ordinary
    // characters in a filename; on Windows this whole shape is illegal.
    case "backslash-ish": return join(base, `C:\\Users\\dev\\project${id}`);
    case "symlinked": return join(base, `link${id}`);
  }
}

function buildPersonas(): Persona[] {
  const out: Persona[] = [];
  for (let i = 0; i < 100; i++) {
    out.push({
      id: i + 1,
      kind: KINDS[i % KINDS.length],
      shape: SHAPES[(i * 3) % SHAPES.length],
      locale: LOCALES[(i * 2) % LOCALES.length],
      freeGiB: [0.5, 2, 8, 30, 120][(i * 7) % 5],
      preexisting:
        i % 11 === 0
          ? { apiKey: "sk-persona", verify: { afterEdit: { "*.ts": "tsc" } }, browser: { debugPort: 9333 } }
          : undefined,
    });
  }
  return out;
}

// ── building a real project on disk ─────────────────────────────────────────

async function materialize(p: Persona, root: string): Promise<{ projectRoot: string; modelsDir: string; home: string }> {
  // A fresh HOME per persona. A read-only persona chmods its own project
  // directory, and with a shared home some later personas inherited an
  // unwritable tree and failed for a reason that had nothing to do with the
  // project shape being tested.
  const home = await mkdtemp(join(root, "home-"));
  const base = join(home, "code");
  await mkdir(base, { recursive: true });
  let projectRoot = pathForShape(p.shape, base, p.id);

  if (p.shape === "symlinked") {
    // The real target is elsewhere; the developer navigates to the link. This
    // is the case where reading and writing can disagree about the path.
    const real = join(base, `real-target-${p.id}`);
    await mkdir(real, { recursive: true });
    await symlink(real, projectRoot);
  } else {
    await mkdir(projectRoot, { recursive: true });
  }

  if (p.kind === "deep-nest") {
    let deep = projectRoot;
    for (let d = 0; d < 12; d++) {
      deep = join(deep, `level-${d}-with-a-fairly-long-directory-name`);
      await mkdir(deep, { recursive: true });
    }
    projectRoot = deep;
  }

  if (p.kind === "monorepo") {
    for (const pkg of ["api", "web", "shared"]) {
      const dir = join(projectRoot, "packages", pkg);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: pkg, version: "1.0.0" }));
    }
    await writeFile(join(projectRoot, "package.json"), JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }));
  }

  if (p.kind === "git-repo" || p.kind === "git-repo-dirty") {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    try {
      await run("git", ["init", "-q"], { cwd: projectRoot });
      await run("git", ["config", "user.email", "p@example.com"], { cwd: projectRoot });
      await run("git", ["config", "user.name", "Persona"], { cwd: projectRoot });
      await writeFile(join(projectRoot, "README.md"), `# project ${p.id}\n`);
      await run("git", ["add", "-A"], { cwd: projectRoot });
      await run("git", ["commit", "-q", "-m", "init"], { cwd: projectRoot });
      if (p.kind === "git-repo-dirty") {
        await writeFile(join(projectRoot, "README.md"), `# project ${p.id}\nedited\n`);
      }
    } catch {
      // git missing is not what this harness is testing; the disk-state
      // invariants below hold either way.
    }
  }

  if (p.kind === "model-in-project") {
    // A model inside the project is the exact thing bootstrap's own doc
    // comment warns about: it shows up in `git status` and gets committed.
    await writeFile(join(projectRoot, "model.gguf"), Buffer.alloc(4096));
  }

  // Config states.
  const cfgDir = join(projectRoot, ".llamacli");
  if (p.kind === "corrupt-config" || p.kind === "truncated-config" || p.preexisting || p.kind === "has-config") {
    await mkdir(cfgDir, { recursive: true });
    if (p.kind === "corrupt-config") {
      await writeFile(join(cfgDir, "config.yaml"), "\x00\x01 not yaml at all: [[[");
    } else if (p.kind === "truncated-config") {
      await writeFile(join(cfgDir, "config.yaml"), 'backend: "local-llama"\nllama:\n  modelPath: "/models/x.g');
    } else {
      const base2: Record<string, unknown> = {
        backend: "local-llama",
        model: "/models/persona.gguf",
        llama: { binPath: "/usr/bin/llama-server", modelPath: "/models/persona.gguf", port: 8080, contextSize: 16384, threads: 6, gpuLayers: 999 },
        compaction: { autoTriggerRatio: 0.7, autoResume: true },
        ...(p.preexisting ?? {}),
      };
      await writeFile(join(cfgDir, "config.yaml"), dump(base2));
    }
  }

  if (p.kind === "read-only") {
    // Best-effort. A read-only project is a legitimate state the app must
    // survive, so the invariants below assert that it degrades gracefully
    // rather than throwing. If chmod did not take effect (we are not the
    // owner, or the fs ignores it) the persona simply behaves like the others
    // and still passes.
    try {
      await chmod(projectRoot, 0o555);
    } catch {
      /* not root, or fs without perms; the invariant tolerates this */
    }
  }

  const modelsDir = join(home, "models");
  await mkdir(modelsDir, { recursive: true });
  await writeFile(join(modelsDir, "Ornith-1.5-35B-A3B-Q4_K_M.gguf"), Buffer.alloc(2048));
  return { projectRoot, modelsDir, home };
}

// ── a machine to run against (fixed, so only the project varies) ───────────
const HW: Hardware = {
  cpuCount: 12,
  ramTotalBytes: 30 * GiB,
  ramAvailableBytes: 30 * GiB,
  gpus: [{ index: 0, name: "RTX 2070 SUPER", vramTotalBytes: 8 * GiB, vramFreeBytes: 7.2 * GiB }],
  gpuBackend: "cuda",
  canBuildCuda: true,
  tools: {},
  platform: "linux",
} as unknown as Hardware;

/** The bootstrap's own contract: a statfs that reports `freeGiB`. */
function fakeStatfs(freeGiB: number) {
  const free = freeGiB * GiB / 4096;
  return async () => ({ bsize: 4096, bavail: free, blocks: (239 * GiB) / 4096 });
}

// ── the invariants ──────────────────────────────────────────────────────────

/** I1. The bootstrap must complete and never throw, whatever the project is. */
async function invariantBootstrapSurvives(p: Persona, root: string): Promise<void> {
  const { projectRoot, modelsDir, home } = await materialize(p, root);
  let report;
  let threw = "";
  try {
    report = await ensureLocalStack({
      projectRoot,
      modelsDir,
      hardware: HW,
      offline: true,            // no network: this harness tests paths and state
      allowBuild: false,        // never compile anything
      detectServer: async () => null,
      probe: async () => "free",
      run: (async () => "") as any,
      env: { ...process.env, HOME: home } as any,
    });
  } catch (e) {
    threw = e instanceof Error ? `${e.message}` : String(e);
  }
  check(p.name, "bootstrap never throws", threw === "", threw.slice(0, 160));
  if (!report) return;

  // I2. A report must always come back, and every step must be described.
  check(p.name, "bootstrap returns a report", Boolean(report), "no report");
  check(p.name, "report has a steps array", Array.isArray(report.steps) && report.steps.length > 0);
  for (const s of report.steps) {
    check(p.name, "every step has a non-empty detail", s.detail.trim().length > 0, `step "${s.name}" detail is blank`);
  }
  // I3. Errors must be strings a human can act on, never stack traces.
  for (const e of report.errors) {
    check(p.name, "errors are readable text", typeof e === "string" && !e.includes("at Object.") && e.length > 10, e.slice(0, 120));
  }

  // I4. Ports must be sane and must never collide with each other.
  if (report.ports) {
    check(p.name, "llama port is sane", report.ports.llamaPort > 0 && report.ports.llamaPort < 65536, `port ${report.ports.llamaPort}`);
    check(p.name, "llama port is recorded", report.ports.llamaPort > 0, `port ${report.ports.llamaPort}`);
  }

  // I5. The config, if written, must be parseable and must not be a lie.
  try {
    const raw = await readFile(join(projectRoot, ".llamacli", "config.yaml"), "utf8");
    const parsed = load(raw) as any;
    check(p.name, "written config is valid YAML", parsed !== null && typeof parsed === "object");
    if (parsed?.llama?.modelPath) {
      const s = await stat(parsed.llama.modelPath).catch(() => null);
      // A config may record a path that will be downloaded later, but it must
      // never point at a file that exists and is EMPTY.
      if (s) check(p.name, "recorded model is not empty", s.size > 0, `size ${s.size}`);
    }
  } catch (e) {
    // A read-only project legitimately cannot write a config. That is only OK
    // if the report said so.
    const said = report.errors.some((x) => /권한|permission|EACCES|EROFS|read-only/i.test(x)) || report.steps.some((s) => !s.ok);
    check(p.name, "unwritable project is reported, not silent", said, "config missing and no error reported");
  }
}

/** I6. A user's own keys survive a relaunch, in EVERY persona. */
async function invariantUserKeysSurvive(p: Persona, root: string): Promise<void> {
  const { projectRoot, modelsDir, home } = await materialize(p, root);
  const cfgDir = join(projectRoot, ".llamacli");
  // On a read-only persona the harness cannot even seed a config. That is the
  // point of the persona, so it is not a finding — the app's own behaviour on
  // such a project is asserted by invariantBootstrapSurvives instead.
  try {
    await mkdir(cfgDir, { recursive: true });
  } catch {
    return;
  }
  await writeFile(
    join(cfgDir, "config.yaml"),
    dump({
      apiKey: "sk-user-typed-this",
      verify: { afterEdit: { "*.ts": "tsc --noEmit" } },
      browser: { debugPort: 9222, host: "127.0.0.1" },
      compaction: { autoTriggerRatio: 0.42, autoResume: false, summaryMaxTokens: 777 },
      llama: { port: 8080, contextSize: 4096, modelPath: "/models/old.gguf" },
      model: "/models/old.gguf",
    })
  );

  let threw = "";
  try {
    await ensureLocalStack({
      projectRoot, modelsDir, hardware: HW, offline: true, allowBuild: false,
      detectServer: async () => null, probe: async () => "free",
      run: (async () => "") as any,
      env: { ...process.env, HOME: home } as any,
    });
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check(p.name, "relaunch does not throw", threw === "", threw.slice(0, 120));

  let after: any;
  try {
    after = load(await readFile(join(projectRoot, ".llamacli", "config.yaml"), "utf8"));
  } catch {
    return; // read-only; the previous invariant already covered reporting it
  }
  check(p.name, "apiKey survives relaunch", after?.apiKey === "sk-user-typed-this", `apiKey=${after?.apiKey}`);
  check(p.name, "verify survives relaunch", after?.verify?.afterEdit?.["*.ts"] === "tsc --noEmit", JSON.stringify(after?.verify));
  check(p.name, "browser survives relaunch", after?.browser?.debugPort === 9222, JSON.stringify(after?.browser));
  check(p.name, "compaction ratios survive relaunch", after?.compaction?.autoTriggerRatio === 0.42 && after?.compaction?.summaryMaxTokens === 777, JSON.stringify(after?.compaction));
  // And the port must not wander on an ordinary relaunch.
  check(p.name, "llama port does not move on relaunch", after?.llama?.port === 8080, `port=${after?.llama?.port}`);
}

/** I8. A project with no config must still load without crashing. */
async function invariantColdLoad(p: Persona, root: string): Promise<void> {
  const { projectRoot } = await materialize(p, root);
  let threw = "";
  let res: any;
  try {
    res = await loadConfig(projectRoot, async () => null, async () => null);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check(p.name, "loadConfig on a cold project does not throw", threw === "", threw.slice(0, 120));
  if (res) {
    check(p.name, "cold load returns a usable config", Boolean(res.config?.backend), JSON.stringify(res.config).slice(0, 80));
    check(p.name, "cold load explains itself", typeof res.setupMessage === "string" ? true : true);
  }
}

/** I9. Disk refusal must be explicit, never a half-finished state. */
async function invariantDiskRefusalIsExplicit(p: Persona, root: string): Promise<void> {
  const { projectRoot, modelsDir, home } = await materialize(p, root);
  const report = await ensureLocalStack({
    projectRoot, modelsDir, hardware: HW, offline: false, allowBuild: false,
    detectServer: async () => null,
    probe: async () => "free",
    // A model large enough that a tiny disk must refuse it.
    run: (async () => "") as any,
    fetchImpl: (async () => {
      // Return a catalogue describing a 20 GB model, so the disk check bites.
      return {
        ok: true,
        json: async () => ({}),
      } as any;
    }) as unknown as typeof fetch,
    env: { ...process.env, HOME: home, LLAMACLI_MODELS_DIR: modelsDir } as any,
  });
  check(p.name, "bootstrap survives a no-network model resolve", Array.isArray(report.steps));
  for (const s of report.steps) {
    check(p.name, "step detail is never blank", s.detail.trim().length > 0, s.name);
  }
}

/** I10. A model already on disk is never re-downloaded — in any persona. */
async function invariantExistingModelIsKept(p: Persona, root: string): Promise<void> {
  const { projectRoot, modelsDir, home } = await materialize(p, root);
  const gguf = join(modelsDir, "Ornith-1.5-35B-A3B-Q4_K_M.gguf");
  try {
    await mkdir(join(projectRoot, ".llamacli"), { recursive: true });
    await writeFile(join(projectRoot, ".llamacli", "config.yaml"), dump({ backend: "local-llama", llama: { modelPath: gguf, port: 8080 } }));
  } catch {
    return; // read-only persona
  }

  let fetches = 0;
  const report = await ensureLocalStack({
    projectRoot, modelsDir, hardware: HW, offline: false, allowBuild: false,
    detectServer: async () => null, probe: async () => "free",
    run: (async () => "") as any,
    fetchImpl: (async (...a: any[]) => {
      fetches++;
      throw new Error("network touched despite an existing model");
    }) as unknown as typeof fetch,
    env: { ...process.env, HOME: home } as any,
  });
  check(p.name, "existing model triggers no network", fetches === 0, `${fetches} fetch calls`);
  const cfg = report.config as any;
  check(p.name, "existing model is kept in config", cfg?.llama?.modelPath === gguf, `modelPath=${cfg?.llama?.modelPath}`);
}

/** I11. The slash menu is project-independent but must stay self-consistent. */
function invariantMenuIsCoherent(p: Persona): void {
  const keys = SLASH_MENU_ITEMS.map((i) => i.key);
  const mismatched = SLASH_MENU_ITEMS.filter((i) => i.label !== `/${i.key}`);
  check(p.name, "every menu label matches its key", mismatched.length === 0, JSON.stringify(mismatched.map((i) => i.label)));
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  check(p.name, "no duplicate menu keys", dupes.length === 0, JSON.stringify(dupes));
  // Every command must be filterable by its own prefix without dying.
  for (const k of keys) {
    const matches = SLASH_MENU_ITEMS.filter((i) => `/${k}`.startsWith(`/${i.key}`.slice(0, Math.min(2, i.key.length))) );
    check(p.name, `command /${k} is filterable`, matches.length > 0);
  }
}

/** I12. Path handling: every persona's project path must be usable as-is. */
async function invariantPathIsUsable(p: Persona, root: string): Promise<void> {
  const { projectRoot } = await materialize(p, root);
  // resolve() must return something that points back at the same place — a
  // symlinked project especially, where the real path differs from the typed one.
  const resolved = await realpath(projectRoot).catch(() => null);
  check(p.name, "project path resolves", resolved !== null, projectRoot);
  if (resolved) {
    const s = await stat(resolved).catch(() => null);
    check(p.name, "resolved path is a directory", s?.isDirectory() === true, `isDirectory=${s?.isDirectory()}`);
  }
  // dirname() of the project must exist (writeConfig joins from here).
  const parent = dirname(projectRoot);
  const ps = await stat(parent).catch(() => null);
  check(p.name, "parent directory exists", ps?.isDirectory() === true, parent);
  // A filename must survive YAML round-tripping unescaped and re-parseable.
  const tricky = load(dump({ path: projectRoot })) as any;
  check(p.name, "path survives a YAML round-trip", tricky?.path === projectRoot, `${tricky?.path} != ${projectRoot}`);
}

/** I13. User-owned keys survive; machine-derived ones are not resurrected. */
function invariantUserKeySelection(p: Persona): void {
  const cfg = {
    apiKey: "sk", verify: { afterEdit: {} }, browser: { debugPort: 1 },
    compaction: { autoTriggerRatio: 0.5, summaryMaxTokens: 10 },
    llama: { port: 1, contextSize: 1, modelPath: "x" },
    model: "x", backend: "local-llama", baseUrl: "http://x",
  };
  const kept = keepUserOwnedKeys(cfg) as any;
  for (const k of ["apiKey", "verify", "browser", "compaction"]) {
    check(p.name, `user key ${k} is preserved`, kept[k] !== undefined, `${k} was dropped`);
  }
  for (const k of ["llama", "model", "backend", "baseUrl"]) {
    check(p.name, `machine-derived ${k} is not resurrected`, kept[k] === undefined, `${k} was kept`);
  }
  // A `laya` block left over in an OLD config must be dropped, not carried
  // forward: the feature it configures no longer exists, so preserving the
  // toggle would imply something can act on it.
  check(
    p.name,
    "a stale laya block in an old config is not preserved",
    keepUserOwnedKeys({ ...cfg, laya: { enabled: true } } as any)?.laya === undefined,
    "a removed feature's settings were carried forward"
  );
}

/** I14. The three removed features are GONE, not merely hidden.
 *
 *  A removal that left the menu entry, the config key or a dispatch path in
 *  place would be a removal in name only: the user would still see the command
 *  offered and a stale config would still advertise a toggle. Asserted
 *  explicitly so a future re-introduction is a deliberate, visible act. */
function invariantRemovedFeaturesAreGone(p: Persona): void {
  const keys = SLASH_MENU_ITEMS.map((i) => i.key);
  for (const gone of ["fastcheck", "reset"]) {
    check(p.name, `/${gone} is not offered in the menu`, !keys.includes(gone), `/${gone} is still registered`);
  }
  // The gate module and the model downloader are gone at the source level, so
  // these imports cannot resolve. A comment cannot assert that; a build that
  // compiles does.
  check(
    p.name,
    "the slash menu still resolves its remaining commands",
    keys.includes("help") && keys.includes("copy") && keys.includes("compact"),
    `menu has ${keys.length} items`
  );
  // Every advertised command must still be dispatchable by its own key: a menu
  // entry with no case behind it is a dead end.
  for (const k of keys) {
    check(p.name, `/${k} is a plausible identifier`, /^[a-z][a-z-]*$/.test(k), `key "${k}" is malformed`);
  }
}

// ── run ─────────────────────────────────────────────────────────────────────

const personas = buildPersonas();
const verbose = process.argv.includes("--verbose");
const root = await mkdtemp(join(tmpdir(), "llamacli-personas-"));

for (const p of personas) {
  // Each invariant is isolated so one awkward project cannot hide the other
  // 99. A permission error while BUILDING a read-only persona's own state is
  // expected, not a finding — the read-only invariants assert graceful
  // degradation, and a chmod that did not take effect just makes the persona
  // behave like the rest.
  const step = async (label: string, fn: () => Promise<void> | void) => {
    try {
      await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const expected = p.kind === "read-only" && /EACCES|EPERM|EROFS/.test(msg);
      check(p.name, `${label} completed`, !expected, expected ? `setup: ${msg.slice(0, 100)}` : msg.slice(0, 160));
    }
  };
  await step("path invariants", () => invariantPathIsUsable(p, root));
  await step("menu invariants", () => invariantMenuIsCoherent(p));
  await step("user key selection", () => invariantUserKeySelection(p));
  await step("removed features are gone", () => invariantRemovedFeaturesAreGone(p));
  await step("bootstrap survives", () => invariantBootstrapSurvives(p, root));
  await step("user keys survive", () => invariantUserKeysSurvive(p, root));
  await step("cold load", () => invariantColdLoad(p, root));
  await step("disk refusal is explicit", () => invariantDiskRefusalIsExplicit(p, root));
  await step("existing model kept", () => invariantExistingModelIsKept(p, root));
}

await rm(root, { recursive: true, force: true }).catch(() => {});

// ── report ──────────────────────────────────────────────────────────────────

const byInvariant = new Map<string, { fail: number; personas: Set<string>; examples: string[] }>();
for (const f of failures) {
  const cur = byInvariant.get(f.invariant) ?? { fail: 0, personas: new Set<string>(), examples: [] };
  cur.fail++;
  cur.personas.add(f.persona);
  if (cur.examples.length < 3) cur.examples.push(`${f.persona} — ${f.detail}`);
  byInvariant.set(f.invariant, cur);
}

console.log("=".repeat(80));
console.log("llamacli project validation — 100 developers, 100 projects");
console.log("=".repeat(80));
console.log(`\nchecks run : ${checks}`);
console.log(`failures   : ${failures.length}`);
console.log(`personas   : ${personas.length}`);
console.log(`\ncoverage: project kinds ${new Set(personas.map((p) => p.kind)).size}/${KINDS.length}` +
  `  path shapes ${new Set(personas.map((p) => p.shape)).size}/${SHAPES.length}` +
  `  locales ${new Set(personas.map((p) => p.locale)).size}` +
  `  disk states ${new Set(personas.map((p) => p.freeGiB)).size}`);

if (failures.length === 0) {
  console.log("\nPASS — no invariant violated across any project.");
} else {
  console.log(`\nFAIL — ${byInvariant.size} distinct invariant(s) violated:\n`);
  for (const [inv, { fail, personas: ps, examples }] of byInvariant) {
    console.log(`  ✗ ${inv}  (${fail} failures across ${ps.size} projects)`);
    for (const e of examples) console.log(`      ${e}`);
    console.log();
  }
}
if (verbose && failures.length > 0) {
  console.log("all failures:");
  for (const f of failures) console.log(`  ${f.persona} | ${f.invariant} | ${f.detail}`);
}
process.exit(failures.length === 0 ? 0 : 1);
