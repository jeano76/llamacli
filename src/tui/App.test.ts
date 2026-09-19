import { test } from "node:test";
import assert from "node:assert/strict";
import { filterMenuItems } from "./App.js";
import { SLASH_MENU_ITEMS } from "./SlashMenu.js";

// Reported directly: the slash menu could only be driven with arrow keys —
// typing the rest of a command's name after "/" did nothing at all. These
// cover the pure filtering logic; the actual key-handling wiring
// (App.tsx's useInput) isn't unit-testable without a full Ink render, but
// this is where a regression in the matching rule itself would show up.
test("filterMenuItems returns every command when the query is empty (just \"/\")", () => {
  assert.deepEqual(filterMenuItems("/"), SLASH_MENU_ITEMS);
});

test("filterMenuItems matches a full command name", () => {
  const result = filterMenuItems("/quit");
  assert.equal(result.length, 1);
  assert.equal(result[0].key, "quit");
});

test("filterMenuItems matches a partial prefix", () => {
  const result = filterMenuItems("/imp");
  assert.deepEqual(
    result.map((i) => i.key),
    ["improve", "improve-apply"]
  );
});

test("filterMenuItems is case-insensitive", () => {
  const result = filterMenuItems("/QUIT");
  assert.equal(result.length, 1);
  assert.equal(result[0].key, "quit");
});

test("filterMenuItems matches a substring anywhere in the command name, not just a prefix", () => {
  const result = filterMenuItems("/apply");
  assert.equal(result.length, 1);
  assert.equal(result[0].key, "improve-apply");
});

test("filterMenuItems returns an empty list when nothing matches, instead of falling back to all commands", () => {
  assert.deepEqual(filterMenuItems("/xyz123"), []);
});

test("filterMenuItems matches the plan-clear command", () => {
  assert.deepEqual(
    filterMenuItems("/plan").map((i) => i.key),
    ["plan-clear"]
  );
});
