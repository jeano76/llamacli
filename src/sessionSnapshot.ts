/**
 * 세션 스냅샷 — 보이는 대화(모델 컨텍스트 전체)의 주기 저장.
 *
 * checkpoint.json(목표·단계·파일·요약)이 "무엇을 하던 중"인지는 알지만
 * "무슨 대화를 나눴는지"는 모른다. 크래시·종료 후 재개하면 계획은 이어지는데
 * 화면은 비어 있다. 이 파일이 그 빈 자리를 메운다: 턴 종료·30초 간격·종료
 * 시점에 loop.messages 전체를 그대로 둔다.
 *
 * 복원은 체크포인트 수락과 함께만 일어난다. 스냅샷만 있고 체크포인트가 없으면
 * (어디까지가 "이어할 일"인지 모른다) 건드리지 않는다 — 혼자 남은 기록으로
 * 모델에게 말을 걸게 하지 않는다. 복원 뒤에는 resume 프롬프트가 평소처럼
 * 주입되므로, 스냅샷 꼬리 + 요약이 겹쳐도 maybeCompact가 트리거를 넘으면
 * 알아서 압축한다.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ChatMessage } from "./backend/types.js";

/** 스냅샷에 남기는 최대 메시지 수. 그 이상은 옛날 것부터 버린다(단 system은 유지). */
export const MAX_SNAPSHOT_MESSAGES = 200;

export function sessionFilePath(projectRoot: string): string {
  return join(projectRoot, ".llamacli", "state", "session.json");
}

export interface SessionSnapshot {
  version: 1;
  savedAt: string;
  messages: ChatMessage[];
}

/** 저장용으로 다듬는다: system 유지 + 최신순 200개. */
export function trimSnapshotMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= MAX_SNAPSHOT_MESSAGES) return messages;
  const [first, ...rest] = messages;
  const tail = rest.slice(-(MAX_SNAPSHOT_MESSAGES - 1));
  return first && first.role === "system" ? [first, ...tail] : [...messages.slice(-MAX_SNAPSHOT_MESSAGES)];
}

export async function saveSessionSnapshot(projectRoot: string, messages: ChatMessage[]): Promise<void> {
  const file = sessionFilePath(projectRoot);
  await mkdir(dirname(file), { recursive: true });
  // JSON 왕복으로 깊은 복사 + 직렬화 가능 것만 남긴다.
  const cleaned = JSON.parse(JSON.stringify(trimSnapshotMessages(messages))) as ChatMessage[];
  const payload: SessionSnapshot = {
    version: 1,
    savedAt: new Date().toISOString(),
    messages: cleaned,
  };
  await writeFile(file, JSON.stringify(payload), "utf8");
}

export async function loadSessionSnapshot(projectRoot: string): Promise<ChatMessage[] | null> {
  let raw: string;
  try {
    raw = await readFile(sessionFilePath(projectRoot), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SessionSnapshot>;
    if (parsed?.version !== 1 || !Array.isArray(parsed.messages) || parsed.messages.length === 0) return null;
    return parsed.messages as ChatMessage[];
  } catch {
    // 깨진 스냅샷은 없는 것과 같다 — 깨진 기록으로 대화를 덮으면 안 된다.
    return null;
  }
}

export async function clearSessionSnapshot(projectRoot: string): Promise<void> {
  await rm(sessionFilePath(projectRoot), { force: true }).catch(() => {});
}
