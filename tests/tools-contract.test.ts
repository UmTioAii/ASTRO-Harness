import { describe, expect, test } from "bun:test";
import {
  TOOL_FAILURES,
  failureResult,
  isToolFailure,
  outputCeilingChars,
  truncationReport,
} from "../src/tools/contract";

describe("tool output contract primitives (S6, #603)", () => {
  test("failure taxonomy is closed: denied, failed, timeout, invalid", () => {
    expect(TOOL_FAILURES).toEqual(["denied", "failed", "timeout", "invalid"]);
    for (const value of TOOL_FAILURES) expect(isToolFailure(value)).toBe(true);
    for (const value of ["error", "cancelled", "", undefined, null, 42]) {
      expect(isToolFailure(value)).toBe(false);
    }
  });

  test("failureResult carries the taxonomy code and an optional policy code", () => {
    expect(failureResult("nope", "denied")).toEqual({ output: "nope", isError: true, failure: "denied" });
    expect(failureResult("nope", "invalid", "invalid_manifest")).toEqual({
      output: "nope",
      isError: true,
      failure: "invalid",
      code: "invalid_manifest",
    });
  });

  test("truncation reports what was removed and how to ask for the rest", () => {
    const report = truncationReport({ removed: 12, total: 30, unit: "entries", hint: "list a subdirectory" });
    expect(report.field).toEqual({ removed: 12, total: 30, unit: "entries", hint: "list a subdirectory" });
    expect(report.marker).toContain("12 of 30 entries omitted");
    expect(report.marker).toContain("list a subdirectory");
  });

  test("ceiling is the declared value lowered by the session cap", () => {
    const ceiling = { maxTokens: 4000, hint: "narrow the path" };
    expect(outputCeilingChars(ceiling, {})).toBe(16_000);
    expect(outputCeilingChars(ceiling, { outputLimitTokens: 1000 })).toBe(4000);
    expect(outputCeilingChars(ceiling, { outputLimitTokens: 9000 })).toBe(16_000);
    expect(outputCeilingChars(undefined, { outputLimitTokens: 9000 })).toBeUndefined();
  });
});
