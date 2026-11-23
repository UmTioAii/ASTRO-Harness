/** #617: token quotas are a Control governance tool; Default only uses the model. */
import { describe, expect, test } from "bun:test";
import { quotasForPreset, teamQuotasForPreset } from "../src/core/config";

const quota = { nvidia: { dailyTokens: 200_000 } };
const agentQuotas = { coder: { dailyTokens: 1_000 } };

describe("#617 quota follows the profile", () => {
  test("default and simple ignore the declared quota", () => {
    expect(quotasForPreset({ preset: "default", quota })).toBeUndefined();
    expect(quotasForPreset({ preset: "simple", quota })).toBeUndefined();
  });

  test("control keeps the declared quota", () => {
    expect(quotasForPreset({ preset: "control", quota })).toEqual(quota);
  });

  test("control without a declared quota stays undefined", () => {
    expect(quotasForPreset({ preset: "control" })).toBeUndefined();
  });

  test("per-agent quotas follow the same rule", () => {
    expect(teamQuotasForPreset({ preset: "default", team: { agentQuotas } })).toBeUndefined();
    expect(teamQuotasForPreset({ preset: "control", team: { agentQuotas } })).toEqual(agentQuotas);
    expect(teamQuotasForPreset({ preset: "control" })).toBeUndefined();
  });
});
