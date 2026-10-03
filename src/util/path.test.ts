import { test } from "node:test";
import assert from "node:assert/strict";
import { baseName, lastSegments } from "./path.js";
import { diffServer } from "../setup/serverPolicy.js";

test("baseName handles POSIX, Windows and mixed separators", () => {
  assert.equal(baseName("/media/x/models/A-Q4_K_M.gguf"), "A-Q4_K_M.gguf");
  assert.equal(baseName("C:\\Users\\me\\models\\A-Q4_K_M.gguf"), "A-Q4_K_M.gguf");
  assert.equal(baseName("C:/Users/me\\models/A.gguf"), "A.gguf");
  assert.equal(baseName("A.gguf"), "A.gguf");
  assert.equal(baseName(""), "");
  assert.equal(baseName("/dir/"), "/dir/", "a trailing separator has no base name: the input is returned, never an empty string");
});

test("lastSegments gives a compact display path on either separator", () => {
  assert.equal(lastSegments("/home/u/llama.cpp/build-opt/bin/llama-server", 2), "bin/llama-server");
  assert.equal(lastSegments("C:\\llama\\bin\\llama-server.exe", 2), "bin/llama-server.exe");
});

test("the restart diff shows model NAMES (not full paths) for Windows paths too", () => {
  const d = diffServer({ modelPath: "C:\\models\\A.gguf" }, undefined, { modelPath: "D:\\other\\B.gguf" });
  assert.deepEqual(d, ["모델: A.gguf → B.gguf"]);
  assert.deepEqual(diffServer({ modelPath: "C:\\models\\A.gguf" }, undefined, { modelPath: "D:\\elsewhere\\A.gguf" }), [], "same file on another drive is the same model");
});
