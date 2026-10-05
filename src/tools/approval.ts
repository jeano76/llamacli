/**
 * 승인 게이트 — 파괴적 도구 호출을 실행 전에 묻는다.
 *
 * 읽기 전용(읽기·메모·계획·스킬조회)은 자동 허용한다. 쓰는 것(파일 쓰기·수정·
 * 셸·브라우저 제어)과 모르는 도구는 묻는다. 모른다는 이유로 자동 허용하면
 * 안 된다 — 새 도구가 추가됐을 때 기본이 열려 있으면 게이트가 없다.
 *
 * 판정만 여기 둔다. 묻는 방법(TUI 오버레이)과 세션 기억(항상 허용)은 호출부(index.tsx)가
 * 갖는다 — 판정과 UI가 한 곳에 있으면 테스트가 터미널을 띄워야 한다.
 */

/** 묻지 않고 통과시키는 읽기 전용 도구. */
export const AUTO_APPROVE_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "note",
  "update_plan",
  "load_skill",
]);

export type ApprovalVerdict = "allow" | "ask";

/** 자동 허용이면 allow, 아니면 ask. 모르는 이름은 ask (열린이 기본이 아니다). */
export function decideToolApproval(name: string, alwaysAllowed?: ReadonlySet<string>): ApprovalVerdict {
  if (AUTO_APPROVE_TOOLS.has(name)) return "allow";
  if (alwaysAllowed?.has(name)) return "allow";
  return "ask";
}

/** 승인 프롬프트에 보여줄 한 줄 요약 — 경로·명령·검색어 순으로 본다. */
export function approvalPreview(name: string, argsJson: string): string {
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    const preview =
      typeof args.path === "string" && args.path
        ? args.path
        : typeof args.command === "string" && args.command
          ? args.command
          : typeof args.query === "string" && args.query
            ? args.query
            : typeof args.name === "string" && args.name
              ? args.name
              : "";
    return preview ? `${name}(${preview.slice(0, 80)})` : name;
  } catch {
    return argsJson ? `${name}(${argsJson.slice(0, 60)})` : name;
  }
}

export interface ApprovalRequest {
  name: string;
  args: string;
}

/** `true`면 실행, `false`면 거부하고 모델에게 그렇게 말한다. */
export type ApprovalGate = (req: ApprovalRequest) => Promise<boolean>;
