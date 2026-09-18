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
      assert.deepEqual(result, { baseUrl: `http://127.0.0.1:${port}`, model: "ornith-1.5-35b" });
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
