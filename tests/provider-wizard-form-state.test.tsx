import { afterAll, expect, mock, test } from "bun:test";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as React from "react";
import type { Dispatch, SetStateAction } from "react";
import { validateConfig } from "../src/core/config";
import { ProfileManager } from "../src/providers/profile-manager";
import { getThemeColors } from "../src/tui/theme";

const realReact = { ...React };
const realUseState = realReact.useState;
const realUseRef = realReact.useRef;
const stateWrites: unknown[] = [];
const refs: Array<{ current: unknown }> = [];

function observedUseState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>] {
  const [state, setState] = realUseState<S>(initial);
  return [state, (next) => { stateWrites.push(next); setState(next); }];
}

function observedUseRef<T>(initial: T): { current: T } {
  const ref = realUseRef<T>(initial);
  refs.push(ref);
  return ref;
}

mock.module("react", () => ({ ...realReact, useState: observedUseState, useRef: observedUseRef }));
afterAll(() => { mock.module("react", () => realReact); });

const { ProviderWizardForm } = await import("../src/tui/provider-wizard-form");

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timeout waiting for frame");
}

test("secret input stays out of React state and its ref is cleared on submit", async () => {
  const home = mkdtempSync(join(tmpdir(), "astro-wizard-state-"));
  const project = validateConfig({
    providers: { p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", maxSteps: 2, tools: [] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  });
  const manager = new ProfileManager({ project, env: { ASTRO_HOME: home } });
  const profile = manager.add({
    name: "Casa", kind: "openai-compat", baseUrl: "https://casa.example/v1", credentialRef: "KEY",
    models: [{ id: "m1", tags: ["writing-code"], context: 8192 }],
  });
  const secret = ["s", "k", "-"].join("") + "live-state-fixture";
  let savedSecret = "";
  let savedId = "";
  const instance = render(
    <ProviderWizardForm
      manager={manager}
      colors={getThemeColors("dark")}
      profile={profile}
      saveSecret={(_id, value) => { savedSecret = value; return "vault:cred-12345678"; }}
      discardSecret={() => undefined}
      onSaved={(saved) => { savedId = saved.id; }}
      onCancel={() => undefined}
      onFailed={() => undefined}
    />,
  );
  try {
    for (const label of ["Nome", "Base URL", "Modelos"]) {
      await waitFor(() => (instance.lastFrame() ?? "").includes(label));
      instance.stdin.write("\r");
    }
    await waitFor(() => (instance.lastFrame() ?? "").includes("Variável da chave"));
    stateWrites.length = 0;
    instance.stdin.write("\u007f".repeat("KEY".length));
    instance.stdin.write(secret);
    const mask = "*".repeat(secret.length);
    await waitFor(() => (instance.lastFrame() ?? "").includes(mask));
    expect(JSON.stringify(stateWrites)).not.toContain(secret);
    expect(stateWrites).toContain(mask);
    expect(refs.some((ref) => ref.current === secret)).toBe(true);

    instance.stdin.write("\r");
    await waitFor(() => (instance.lastFrame() ?? "").includes("Confirmar"));
    instance.stdin.write("\r");
    await waitFor(() => savedId === profile.id);
    expect(savedSecret).toBe(secret);
    expect(refs.some((ref) => ref.current === secret)).toBe(false);
    expect(JSON.stringify(stateWrites)).not.toContain(secret);
  } finally {
    instance.unmount();
  }
});
