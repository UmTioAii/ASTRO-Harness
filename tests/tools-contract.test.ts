import { describe, expect, test } from "bun:test";
import { TOOL_FAILURES, failureResult, isToolFailure, truncationReport } from "../src/tools/contract";

describe("tool output contract primitives (S6, #603)", () => {
  test("failure taxonomy is closed and failureResult carries the code", () => {
    expect(TOOL_FAILURES).toEqual(["denied", "failed", "timeout", "invalid"]);
    for (const value of TOOL_FAILURES) expect(isToolFailure(value)).toBe(true);
    for (const value of ["error", "cancelled", "", undefined, null, 42]) expect(isToolFailure(value)).toBe(false);
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
});
