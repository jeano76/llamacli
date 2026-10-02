import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, Server } from "node:http";
import { detectRunningServer } from "./detect.js";

async function withFakeServer(
  handler: (req: any, res: any) => void,
  fn: (port: number) => Promise<void>
): Promise<void> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function unusedPorts(n: number): number[] {
  // High, unlikely-to-be-bound ports for "nothing listening" cases.
  return Array.from({ length: n }, (_, i) => 39300 + i);
}

test("detectRunningServer returns null when nothing is listening on any candidate port", async () => {
  const result = await detectRunningServer("127.0.0.1", unusedPorts(3));
  assert.equal(result, null);
});

test("detectRunningServer finds a real /v1/models responder and returns its baseUrl + first model id", () =>
  withFakeServer(
    (req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "ornith-1.5-35b" }] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    },
    async (port) => {
      const result = await detectRunningServer("127.0.0.1", [...unusedPorts(2), port]);
      // Field-wise rather than deepEqual: `verified` is part of the result now,
      // and a fixture that answers /v1/models with a bare name and 404s /props
      // is correctly classified "other" (a usable non-llama.cpp server).
      assert.equal(result?.baseUrl, `http://127.0.0.1:${port}`);
      assert.equal(result?.model, "ornith-1.5-35b");
      assert.equal(result?.verified, "other");
    }
  ));

test("detectRunningServer falls back to a default model id when /v1/models returns no data", () =>
  withFakeServer(
    (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({}));
    },
    async (port) => {
      const result = await detectRunningServer("127.0.0.1", [port]);
      assert.equal(result?.model, "local-model");
    }
  ));

test("detectRunningServer ignores a port that responds but with a non-OK status", () =>
  withFakeServer(
    (req, res) => {
      res.writeHead(500);
      res.end();
    },
    async (port) => {
      const result = await detectRunningServer("127.0.0.1", [port]);
      assert.equal(result, null);
    }
  ));

test("detectRunningServer prefers the first candidate port that responds, in port list order", () =>
  withFakeServer(
    (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "second" }] }));
    },
    async (secondPort) => {
      await withFakeServer(
        (req, res) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: [{ id: "first" }] }));
        },
        async (firstPort) => {
          const result = await detectRunningServer("127.0.0.1", [firstPort, secondPort]);
          assert.equal(result?.model, "first");
        }
      );
    }
  ));

// ── a CI fixture must not be adopted as a model server ─────────────────────
//
// The live incident: harnessCli's `fake-llama-server.mjs`, wired in through
// HARNESSIDE_LLAMA_SERVER, took port 8080 after the real llama-server was
// stopped. It answers /health and /v1/models correctly and returns a canned
// "가짜 응답입니다." to every completion — so llamacli adopted it silently and
// looked like a working session.
//
// Note what does NOT catch it: resolve.ts's existing "garbage" health probe
// sends a prompt and asks whether the reply is language. "가짜 응답입니다." is
// valid Korean, so that check passes it. A missing weights file cannot be
// argued around, which is why this check exists alongside it.

test("a server whose model file does not exist is classified as a stub, not adopted", async () => {
  const { detectRunningServer: detect } = await import("./detect.js");
  await withFakeServer(
    (req, res) => {
      const json = (body: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url === "/v1/models") json({ data: [{ id: "/fake/model.gguf" }] });
      else if (req.url === "/props") json({ n_ctx: 16384, model_path: "/fake/model.gguf" });
      else {
        res.writeHead(404);
        res.end();
      }
    },
    async (port) => {
      const result = await detect("127.0.0.1", [...unusedPorts(2), port]);
      assert.equal(result, null, "a stub must not be adopted");
    }
  );
});

test("findStubServers reports the stub and says why", async () => {
  const { findStubServers } = await import("./detect.js");
  await withFakeServer(
    (req, res) => {
      const json = (body: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url === "/v1/models") json({ data: [{ id: "/fake/model.gguf" }] });
      else if (req.url === "/props") json({ model_path: "/fake/model.gguf" });
      else {
        res.writeHead(404);
        res.end();
      }
    },
    async (port) => {
      const stubs = await findStubServers("127.0.0.1", [...unusedPorts(2), port]);
      assert.equal(stubs.length, 1, "the stub is reported, not silently skipped");
      assert.equal(stubs[0].verified, "stub");
      assert.match(stubs[0].reason ?? "", /model\.gguf/, `reason did not name the file: ${stubs[0].reason}`);
      assert.match(stubs[0].reason ?? "", /더블 서버/, "reason should say what kind of thing this is");
    }
  );
});

test("a real llama.cpp is recognised by build_info even if its path check would fail", async () => {
  // build_info is authoritative: llama.cpp always emits it. A model path that
  // happens to be unreadable from THIS process (permissions, a network mount
  // that is down) must not turn a real server into a stub — refusing it would
  // risk spawning a second llama-server onto a card the first one already
  // holds, which is the failure this whole check exists near.
  const { detectRunningServer: detect } = await import("./detect.js");
  await withFakeServer(
    (req, res) => {
      const json = (body: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url === "/v1/models") json({ data: [{ id: "/media/models/x.gguf" }] });
      else if (req.url === "/props") json({ build_info: "b1234", model_path: "/media/models/x.gguf" });
      else {
        res.writeHead(404);
        res.end();
      }
    },
    async (port) => {
      const result = await detect("127.0.0.1", [...unusedPorts(2), port]);
      assert.equal(result?.verified, "llama.cpp", "build_info must win over the file-existence check");
    }
  );
});

test("Ollama-style model names are still adopted, not mistaken for a stub", async () => {
  // Its ids are names, not filesystem paths, so the stub test cannot catch a
  // genuinely working Ollama on 11434. If this ever regressed, Ollama support
  // would break.
  const { detectRunningServer: detect } = await import("./detect.js");
  await withFakeServer(
    (req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "llama3:8b" }] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    },
    async (port) => {
      const result = await detect("127.0.0.1", [...unusedPorts(2), port]);
      assert.equal(result?.model, "llama3:8b");
      assert.equal(result?.verified, "other");
    }
  );
});

test("both /v1/models shapes are read, so the recorded model is never a guess", async () => {
  // llama.cpp has shipped both `data[].id` and a `models[]` array. Missing the
  // second silently records "local-model", a name the server does not have.
  const { detectModelAt } = await import("./detect.js");
  for (const body of [
    { data: [{ id: "/m/a.gguf" }] },
    { models: [{ name: "/m/a.gguf", model: "/m/a.gguf" }] },
  ]) {
    await withFakeServer(
      (req, res) => {
        if (req.url === "/v1/models") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(body));
        } else {
          res.writeHead(404);
          res.end();
        }
      },
      async (port) => {
        assert.equal(await detectModelAt(`http://127.0.0.1:${port}`), "/m/a.gguf");
      }
    );
  }
});
