/**
 * Making a model selection actually RUN, rather than only being recorded.
 *
 * ── The gap this closes ──────────────────────────────────────────────────────
 * `/models <n>` writes the choice to config and reports whether the llama-server
 * that would serve it can read it. When the answer was "no binary can read this"
 * or "the weights are not on disk yet", it stopped there and said the next launch
 * would handle it. So the selection was recorded but nothing was serving it, and
 * the user's next move was to quit and relaunch — for work the tool could have
 * done itself, and could do without stopping anything.
 *
 * This module does that work: it finds (or installs, or compiles) a llama-server
 * that reads the chosen quantization, fetches the weights when they are missing,
 * and hands back everything `switchModelAndServer` needs to swap the server.
 *
 * ── It provisions; it does not switch ─────────────────────────────────────────
 * Deliberately not one step further. `switchModelAndServer` owns stopping the
 * old server, and it does that with real care — it attributes the port holder
 * before touching it and refuses to kill a stranger's process. Folding that in
 * here would mean two modules each able to stop a server, and the port would get
 * stopped by whichever ran first.
 *
 * ── Three ways this could wreck a working machine, and how each is prevented ──
 *
 * 1. ADOPTING THE SERVER IT IS ABOUT TO REPLACE. The bootstrap's first act is to
 *    discover a running server and return early when it finds one — that is right
 *    at startup and exactly wrong here, because the server it would adopt is the
 *    one holding the OLD model, and adopting it would skip provisioning entirely
 *    and leave the selection recorded but unserved. So detection is short-circuited
 *    to "none" below. The port is still probed; only the adopt short-circuit is
 *    bypassed.
 *
 * 2. MOVING THE PORT. `planPorts` answers "where can a NEW server bind", and it
 *    answers by MOVING off an occupied port — on this machine, a recorded 8084
 *    with 8080 free becomes 8080. For a model switch the recorded port is not a
 *    question to re-derive, it is the answer: the old server is about to be
 *    stopped and the new one takes its place. So the recorded port is reported
 *    available. Left alone this is the two-server OOM the module exists to
 *    prevent — a second server on a card whose first server already holds most
 *    of the VRAM.
 *
 * 3. `force: true`. That flag is what `/reset` uses, and it is wrong here for a
 *    concrete reason: it keeps only user-owned config keys, which discards
 *    `llama.port` and `llama.binPath` — the very two fields this path exists to
 *    carry forward. Everything is therefore re-derived in NON-force mode, from
 *    the config `selectModel` just wrote.
 */

import { ensureLocalStack, type BootstrapOptions } from "./bootstrap.js";
import { tcpPortProbe, type PortProbe, type PortState } from "./ports.js";
import type { LlamaTuning } from "./tuning.js";
import type { Hardware } from "./hardware.js";

export interface ProvisionOptions {
  projectRoot: string;
  /** The port the replacement server must keep using. Pinned, never re-planned. */
  port: number;
  hardware: Hardware;
  /** Per-line output for the TUI log. */
  log: (line: string) => void;
  /** Progress reporter, same seam `/reset` uses: the TUI owns the screen. */
  onProgress?: BootstrapOptions["onProgress"];
  /** Injected for tests. Defaults to the real bootstrap. */
  ensureLocalStack?: typeof ensureLocalStack;
  /** Injected for tests. Defaults to a real TCP probe, with `port` pinned free. */
  probe?: PortProbe;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

export interface ProvisionResult {
  ok: boolean;
  /** A binary that can read the selected model, when one was obtained. */
  binPath?: string;
  /** Where the weights are, once present. */
  modelPath?: string;
  /** The port, unchanged. */
  port: number;
  /** Tuning derived for this model; the switch must use these, not the old ones. */
  tuning?: LlamaTuning;
  /** User-facing lines. */
  lines: string[];
}

/** A probe that treats `port` as bindable and everything else as real.
 *
 *  The one lie in this module, and it is a lie about the right thing: the port IS
 *  bindable by the time the switch runs, because the old server is stopped first.
 *  A truthful probe here would make `planPorts` walk off to another port, and the
 *  session would end up served on a port the user never chose. */
export function pinnedPortProbe(port: number, real: PortProbe = tcpPortProbe): PortProbe {
  return async (p: number): Promise<PortState> => (p === port ? "free" : real(p));
}

/**
 * Installs/builds a llama-server that can read the configured model, and makes
 * sure the weights are on disk. Returns what a server switch needs.
 *
 * Never throws for an expected failure — a missing compiler, a full disk, a
 * quant nothing can read all come back as `ok: false` with lines explaining
 * what happened. The caller is a slash command inside a live session, where an
 * exception would take down a working install to report a problem.
 */
export async function provisionForSwitch(opts: ProvisionOptions): Promise<ProvisionResult> {
  const port = opts.port;
  const lines: string[] = [];
  const ensure = opts.ensureLocalStack ?? ensureLocalStack;
  const probe = opts.probe ?? pinnedPortProbe(port);

  let report;
  try {
    report = await ensure({
      projectRoot: opts.projectRoot,
      // Explicit: without this the bootstrap would report "not installed" rather
      // than compiling, which is the outcome the user asked for by selecting a
      // model they cannot run yet.
      allowBuild: true,
      // NOT force — see the third hazard above.
      force: false,
      // "No server to adopt." The one on this port is serving the previous model
      // and is about to be replaced; adopting it would skip every step below.
      detectServer: async () => ({ kind: "none" as const }),
      probe,
      log: (line) => {
        lines.push(line);
        opts.log(line);
      },
      onProgress: opts.onProgress,
      hardware: opts.hardware,
      env: opts.env,
      fetchImpl: opts.fetchImpl,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lines.push(`llama-server 준비 중 오류: ${message}`);
    opts.log(lines[lines.length - 1]);
    return { ok: false, port, lines };
  }

  const binPath = report.llama?.binPath;
  const modelPath = report.modelPath;
  const tuning = report.tuning;

  if (!binPath) {
    lines.push("이 모델을 읽을 수 있는 llama-server 를 준비하지 못했습니다. 아래 사유를 확인하세요.");
  }
  if (!modelPath) {
    lines.push("모델 파일을 확보하지 못했습니다. 디스크 공간과 네트워크를 확인하세요.");
  }

  const portKept = report.ports?.llamaPort === port;
  if (binPath && !portKept) {
    // Should be unreachable — the probe above pins it — but a switch that quietly
    // moved the port is precisely the failure this module is written around, so it
    // is refused rather than performed.
    lines.push(
      `기록된 포트(${port})를 ${report.ports?.llamaPort} 로 바꾸려는 결과가 나왔습니다. ` +
        `서버 교체는 하지 않습니다 — 포트는 사용자가 정한 값입니다.`
    );
    return { ok: false, port, lines };
  }

  const ok = Boolean(binPath && modelPath) && report.ok;
  return {
    ok,
    binPath,
    modelPath,
    port,
    tuning,
    lines: [...lines, ...(ok ? [`준비 완료: ${binPath} · ${modelPath} (포트 ${port} 그대로)`] : [])],
  };
}