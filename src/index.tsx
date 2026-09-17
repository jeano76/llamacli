#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { App } from "./tui/App.js";
import { loadConfig } from "./config.js";
import { loadRules, loadSkillIndex, injectRulesIntoSystemPrompt } from "./skills/loader.js";
import { SLASH_MENU_ITEMS } from "./tui/SlashMenu.js";
import { LlamaServerManager } from "./backend/llamaServer.js";
import { OpenAICompatibleClient } from "./backend/openaiClient.js";
import { AgentLoop } from "./agent/loop.js";

const BASE_SYSTEM_PROMPT = `당신은 llamacli, 로컬 llama.cpp 기반 코딩 에이전트입니다.
우수한 소프트웨어 아키텍트의 기본기(최소 diff, 기존 컨벤션 준수, 검증 없는 변경 금지,
파괴적 명령 전 확인)를 항상 따르세요.

여러 단계가 필요한 작업을 시작할 때는 update_plan 도구로 단계 목록을 선언하고,
각 단계를 시작/완료할 때마다 상태(todo/in_progress/done)를 갱신하세요. 이 계획은
컨텍스트 컴팩션이 발생해도 그대로 보존되어 작업을 정확히 이어갈 수 있게 해줍니다.`;

async function main() {
  const projectRoot = process.cwd();
  const config = await loadConfig(projectRoot);
  const rules = await loadRules(projectRoot);
  const skillIndex = await loadSkillIndex(projectRoot);
  const systemPrompt = injectRulesIntoSystemPrompt(BASE_SYSTEM_PROMPT, rules);

  let backend: OpenAICompatibleClient;
  if (config.backend === "local-llama" && config.llama?.modelPath) {
    const manager = new LlamaServerManager({
      binPath: config.llama.binPath,
      modelPath: config.llama.modelPath,
      host: "127.0.0.1",
      port: config.llama.port,
      contextSize: config.llama.contextSize,
      threads: config.llama.threads,
      gpuLayers: config.llama.gpuLayers,
    });
    await manager.start();
    backend = manager.client();
  } else {
    backend = new OpenAICompatibleClient(config.baseUrl ?? "http://127.0.0.1:8081", config.apiKey);
  }

  const loop = new AgentLoop({
    projectRoot,
    model: config.model,
    backend,
    systemPrompt,
    thresholds: {
      autoTriggerRatio: config.compaction.autoTriggerRatio,
      contextWindowTokens: config.llama?.contextSize ?? 8192,
    },
    onAssistantDelta: (t) => (globalThis as any).__llamacli_ui?.pushAssistantDelta(t),
    onAssistantDone: () => (globalThis as any).__llamacli_ui?.finalizeAssistant(),
    onToolCall: (name, args) => (globalThis as any).__llamacli_ui?.pushTool(`[tool] ${name} ${args}`),
    onDiff: (_path, diff) => (globalThis as any).__llamacli_ui?.pushDiff(diff),
    onStatus: (s) => (globalThis as any).__llamacli_ui?.pushStatus(s),
  });

  // Session-end self-improvement gate (PROMPT.md §3): if failures were
  // logged and never reviewed, /quit shows the proposal instead of exiting —
  // a second /quit confirms. Applying the proposal (if any) always requires
  // the separate explicit /improve-apply, never happens on quit itself.
  let quitConfirmed = false;

  const { unmount } = render(
    <App
      cwd={projectRoot}
      model={config.model}
      onSubmit={async (text) => {
        (globalThis as any).__llamacli_ui?.setBusy(true);
        try {
          await loop.send(text);
        } finally {
          (globalThis as any).__llamacli_ui?.setBusy(false);
        }
      }}
      onSlashCommand={(key) => {
        const ui = (globalThis as any).__llamacli_ui;
        switch (key) {
          case "quit": {
            if (quitConfirmed || !loop.hasFailureLog()) {
              unmount();
              break;
            }
            quitConfirmed = true;
            ui?.pushStatus("[세션 종료 전 자가 개선 분석 중...]");
            loop
              .proposeSelfImprovement()
              .then((proposal) => {
                if (!proposal) {
                  ui?.pushStatus("반복 실패 패턴이 없어 제안할 rule이 없습니다. /quit을 다시 누르면 종료됩니다.");
                  return;
                }
                ui?.pushStatus(
                  [
                    `[자가 개선 제안] ${proposal.summary}`,
                    "",
                    proposal.ruleMarkdown,
                    "",
                    "적용하려면 /improve-apply, 무시하고 종료하려면 /quit을 다시 누르세요.",
                  ].join("\n")
                );
              })
              .catch((err: any) => ui?.pushStatus(`[자가 개선 분석 실패] ${err.message}`));
            break;
          }
          case "help": {
            const lines = SLASH_MENU_ITEMS.map((i) => `${i.label.padEnd(10)} ${i.description}`);
            ui?.pushStatus(
              [
                "사용 가능한 슬래시 명령:",
                ...lines,
                "",
                "컨텍스트가 임계치에 도달하면 자동으로 컴팩션되고, 완료 후 하던 작업을 스스로 이어갑니다.",
              ].join("\n")
            );
            break;
          }
          case "compact":
            ui?.pushStatus(
              ui?.isBusy?.() ? "[컴팩션 예약됨] 진행 중인 작업이 끝나면 실행됩니다." : "[컴팩션 시작]"
            );
            ui?.setBusy(true);
            loop
              .forceCompact()
              .catch((err: any) => ui?.pushStatus(`[컴팩션 실패] ${err.message}`))
              .finally(() => ui?.setBusy(false));
            break;
          case "skills":
            ui?.pushStatus(
              skillIndex.length
                ? `로드된 skill:\n${skillIndex.map((s) => `- ${s.name}: ${s.trigger}`).join("\n")}`
                : "등록된 skill이 없습니다 (.llamacli/skills/*.md)."
            );
            break;
          case "rules":
            ui?.pushStatus(
              rules.length
                ? `로드된 rule:\n${rules.map((r) => `- ${r.path}`).join("\n")}`
                : "적용된 rule이 없습니다 (.llamacli/rules/ 또는 .clinerules)."
            );
            break;
          case "improve":
            ui?.pushStatus("[자가 개선 분석 중...]");
            loop
              .proposeSelfImprovement()
              .then((proposal) => {
                ui?.pushStatus(
                  proposal
                    ? [
                        `[자가 개선 제안] ${proposal.summary}`,
                        "",
                        proposal.ruleMarkdown,
                        "",
                        "적용하려면 /improve-apply를 실행하세요 (직접 호출 전까지는 아무 파일도 바뀌지 않습니다).",
                      ].join("\n")
                    : "반복되는 실패 패턴이 아직 없어 제안할 rule이 없습니다."
                );
              })
              .catch((err: any) => ui?.pushStatus(`[자가 개선 분석 실패] ${err.message}`));
            break;
          case "improve-apply":
            loop
              .applyPendingImprovement()
              .then((path) => {
                ui?.pushStatus(
                  path
                    ? `[rule 저장됨] ${path} (다음 세션부터 시스템 프롬프트에 자동 주입됩니다)`
                    : "적용할 제안이 없습니다. 먼저 /improve를 실행하세요."
                );
              })
              .catch((err: any) => ui?.pushStatus(`[rule 저장 실패] ${err.message}`));
            break;
          // "queue" is handled locally inside App (needs the live queue state).
        }
      }}
    />
  );

  await loop.resumeIfCheckpointExists();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
