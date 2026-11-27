import { describe, expect, test } from "bun:test";
import { auditLabel } from "../src/compaction/audit-label";
import { ProviderError } from "../src/providers/types";

describe("compaction failure audit label", () => {
  test("a classified provider error is audited with its D-18 class", () => {
    expect(auditLabel(new ProviderError("auth", "missing credential"))).toBe("auth");
    expect(auditLabel(new ProviderError("transient_rate_limit", "slow down"))).toBe("transient_rate_limit");
  });

  test("a provider error subclass keeps the inherited D-18 class", () => {
    class QuotaError extends ProviderError {}
    expect(auditLabel(new QuotaError("hard_quota", "quota exhausted"))).toBe("hard_quota");
  });

  test("any other error is audited as `unclassified`", () => {
    expect(auditLabel(new TypeError("boom"))).toBe("unclassified");
    expect(auditLabel(new Error("boom"))).toBe("unclassified");
    expect(auditLabel("boom")).toBe("unclassified");
    expect(auditLabel(undefined)).toBe("unclassified");
  });
});
