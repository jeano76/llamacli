---
trigger: testing behavior from the outside (API, CLI, UI) without relying on implementation internals — e2e/acceptance/contract testing
---

# Black-box testing

- Test only through the public interface (API contract, CLI invocation,
  UI interaction) — never assert on internal state or call implementation
  functions directly. If the implementation changes but the contract
  doesn't, these tests must still pass unmodified.
- Derive cases from the spec/contract, not from reading the implementation:
  documented inputs and outputs, documented error responses, documented
  edge cases. If the spec is silent on an edge case, that's itself worth
  flagging, not silently assuming one behavior.
- Cover the realistic failure modes a real caller hits: invalid input,
  missing auth, timeout/unavailable dependency, malformed payloads —
  verify the observable error response, not just the happy path.
- For this CLI specifically: prefer driving real behavior over mocking
  where practical (e.g. a real local server response beats a stubbed one)
  since it catches integration drift that a mock can't.
- Record exact reproduction steps for every failure found (command run,
  input given, expected vs actual output) so it can be re-verified after a
  fix without re-deriving the case.
