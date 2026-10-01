import type { ModelBackend } from "./types.js";

/**
 * Asks a backend to echo a fixed sentinel, and judges the reply.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * `resolve.ts` adopts whatever llama-server is already answering, and treats
 * "it answered" as "it works". Those are not the same thing, and the gap is
 * expensive: a server whose weights are unusable still loads, still serves
 * `/props`, still accepts every request and still returns HTTP 200 with a
 * well-formed completion — it just returns nonsense.
 *
 * Measured live, exactly that: a GGUF whose 750 of 753 tensors were zero
 * bytes (a `.part` download renamed to `.gguf`) produced a valid, streaming,
 * correctly-shaped response to every request, containing nothing but garbage —
 * `"most也是最!!"голо!!"sten lem!!"culator!!..."` at temperature 0, byte for
 * byte identical across runs. The session ran for seven hours like that,
 * because nothing between the file and the screen ever asked whether the
 * output was language.
 *
 * The check is deliberately about *output*, not about the model file. Zero
 * weights are one way to get here; a wrong architecture, a broken build, a bad
 * GPU offload and a half-written download all land in the same place, and all
 * of them are caught by asking the server one question and reading the answer.
 */
export type BackendHealth =
  /** The model echoed the sentinel. */
  | { verdict: "healthy"; sample: string }
  /** The server answered, but the answer is not the model working. */
  | { verdict: "garbage"; sample: string; reason: string }
  /** The probe itself could not be completed (unreachable, non-llama.cpp
   *  backend, an endpoint that doesn't do chat at all). Connectivity is not
   *  this probe's job — the agent loop already reports that clearly — so an
   *  inconclusive probe must never be read as a broken model. */
  | { verdict: "unknown"; sample: ""; reason: string };

/** Deliberately not a word: no real model has a reason to emit it, and no
 *  chat template or system prompt is going to contain it by accident. */
const PROBE_SENTINEL = "ZQXVKJ";

/** Enough for the echo plus a model's typical "Sure! **ZQXVKJ**" wrapping, and
 *  small enough that the probe costs ~2s on the local backend. */
const PROBE_MAX_TOKENS = 48;

/** Case- and punctuation-insensitive containment. A model that answers
 *  `"ZQXVKJ."` or `**ZQXVKJ**` passed; one that answers something else didn't. */
function echoesSentinel(text: string): boolean {
  const norm = (s: string) => s.replace(/[^a-z0-9]/gi, "").toUpperCase();
  return norm(text).includes(norm(PROBE_SENTINEL));
}

/** Trimmed for display, and bounded: a garbage model can produce a very long
 *  run of it, and this string goes into a status line in the TUI log. */
function summarize(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 120 ? `${collapsed.slice(0, 120)}…` : collapsed;
}

/**
 * One tiny deterministic request. Never throws — an unreachable backend is
 * reported as `unknown`, not as a broken model.
 *
 * Two request fields are load-bearing:
 *
 *  - `chat_template_kwargs: { enable_thinking: false }`. A reasoning model
 *    otherwise spends the entire budget on invisible `reasoning_content` and
 *    returns an empty `content`. Measured on this project's own backend with
 *    the budget left at 12,288: 73,175 characters of reasoning, zero
 *    characters of answer. An empty reply would then read as "broken" for a
 *    perfectly healthy model, so thinking is turned off explicitly.
 *  - `temperature: 0`. Greedy, so the verdict does not flap between runs on
 *    the same broken server, and so a working model's answer is stable.
 */
export async function probeBackendHealth(backend: ModelBackend): Promise<BackendHealth> {
  let text: string;
  try {
    const res = await backend.chat({
      model: "health-probe",
      messages: [{ role: "user", content: `Repeat this exact string and nothing else: ${PROBE_SENTINEL}` }],
      stream: false,
      temperature: 0,
      max_tokens: PROBE_MAX_TOKENS,
      repeat_penalty: 1.1,
      chat_template_kwargs: { enable_thinking: false },
    });
    text = res.choices?.[0]?.message?.content ?? "";
  } catch (err: any) {
    return { verdict: "unknown", sample: "", reason: err?.message ?? String(err) };
  }

  const sample = summarize(text);
  if (echoesSentinel(text)) return { verdict: "healthy", sample };
  return {
    verdict: "garbage",
    sample,
    reason: sample
      ? `간단한 반복 지시에도 지시한 문자열을 그대로 돌려주지 못했습니다.`
      : `내용 없이 빈 응답만 돌아왔습니다.`,
  };
}

/** The message shown to the user when the probe fails. Deliberately includes
 *  the model's actual words: "the model is broken" is a claim they should be
 *  able to check for themselves, and the sample is what makes it checkable. */
export function describeUnhealthyBackend(where: string, health: Extract<BackendHealth, { verdict: "garbage" }>): string {
  return (
    `${where} 서버가 응답은 하지만 정상적인 출력을 만들지 못했습니다. ` +
    `${health.reason}\n` +
    `  모델 응답 샘플: ${health.sample ? `"${health.sample}"` : "(빈 응답)"}\n` +
    `  대개 원인은 모델 파일이 손상된 경우입니다 (다운로드 중단된 파일이 .gguf로 이름을 바꾸었거나, ` +
    `가중치 영역이 0으로 채워져 있음). 이 서버를 그대로 쓰면 모든 응답이 무의미한 문자열로 채워집니다. ` +
    `모델 파일을 다시 내려받은 뒤 서버를 종료하고 다시 실행하세요.`
  );
}