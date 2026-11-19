import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireAgentLock, activeLocks, releaseAgentLock } from "../src/agent-lock";
import { Auditor } from "../src/audit";
import { Ledger, type LedgerAgentEntry } from "../src/ledger";
import { formatAge, releaseObservedLock, summarizeLocks } from "../src/locks";

const identity = { provider: "proj", model: "m1", credentialRef: "CRED_KEY" };

function setup(): { ledger: Ledger; audit: Auditor; ledgerPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "astro-locks-"));
  const ledgerPath = join(dir, "ledger.jsonl");
  return {
    ledger: new Ledger(ledgerPath),
    audit: new Auditor(join(dir, "audit.jsonl")),
    ledgerPath,
  };
}

describe("release usa o snapshot observado (#527)", () => {
  test("recusa liberar quando o lock foi readquirido entre a leitura e a escrita", () => {
    const { ledger, audit } = setup();
    const deadPid = 999_999;
    acquireAgentLock(ledger, audit, {
      run: "r1", agent_id: "default", session_id: "r1", ...identity, pid: deadPid,
    });
    const observed = summarizeLocks(ledger, () => false)[0]!;

    // Outro processo: libera o lock morto e readquire a conta com o MESMO pid
    // e seq novo — quem recusa é a guarda de seq, não a de pid.
    releaseAgentLock(ledger, audit, {
      run: "r1", agent_id: "default", reason: "crash_recovered", pid: deadPid, seq: observed.seq,
    });
    acquireAgentLock(ledger, audit, {
      run: "r1", agent_id: "default", session_id: "r1", ...identity, pid: deadPid,
    });

    const outcome = releaseObservedLock(ledger, audit, observed);

    expect(outcome.released).toBe(false);
    expect(outcome.message).toContain("mudou desde a leitura");
    // O lock novo continua preso: a exclusividade não foi quebrada (A4).
    expect(activeLocks(ledger)).toHaveLength(1);
    const denied = audit.readAll().filter((entry) => entry.tipo === "agent.lock.release_denied");
    expect(denied.at(-1)!.payload).toMatchObject({ agent_id: "default", reason: "lock_changed", pid: deadPid });
  });

  test("ledger legado sem seq recusa liberar (falha fechada)", () => {
    const { ledger, audit, ledgerPath } = setup();
    appendFileSync(ledgerPath, `${JSON.stringify({
      schemaVersion: 3,
      ts: new Date().toISOString(),
      run: "r1",
      kind: "agent",
      event: "created",
      agent_id: "default",
      session_id: "r1",
      credentialRef: "CRED_KEY",
      pid: 999_999,
    })}\n`);
    const observed = summarizeLocks(ledger, () => false)[0]!;

    expect(observed.seq).toBeUndefined();
    const outcome = releaseObservedLock(ledger, audit, observed);

    expect(outcome.released).toBe(false);
    expect(outcome.message).toContain("seq");
    expect(activeLocks(ledger)).toHaveLength(1);
    const denied = audit.readAll().filter((entry) => entry.tipo === "agent.lock.release_denied");
    expect(denied.at(-1)!.payload).toMatchObject({ agent_id: "default", reason: "missing_seq" });

    // `--force` não reabre a falha fechada: sem seq não há como provar o lock.
    const forced = releaseObservedLock(ledger, audit, observed, { force: true });
    expect(forced.released).toBe(false);
    expect(forced.message).toContain("seq");
  });

  test("--force com dono vivo audita manual_release_forced", () => {
    const { ledger, audit } = setup();
    acquireAgentLock(ledger, audit, {
      run: "r1", agent_id: "default", session_id: "r1", ...identity, pid: process.pid,
    });
    const observed = summarizeLocks(ledger)[0]!;

    const outcome = releaseObservedLock(ledger, audit, observed, { force: true });

    expect(outcome.released).toBe(true);
    const released = audit.readAll().filter((entry) => entry.tipo === "agent.lock.released");
    expect(released.at(-1)!.payload).toMatchObject({
      agent_id: "default",
      accountRef: "CRED_KEY",
      reason: "manual_release_forced",
    });
    const destroyed = ledger.readAllEntries().filter(
      (entry): entry is LedgerAgentEntry => entry.kind === "agent" && entry.event === "destroyed",
    );
    expect(destroyed.at(-1)!.reason).toBe("manual_release_forced");
  });

  test("ledger legado sem pid lista como desconhecido e libera sem --force", () => {
    const { ledger, audit, ledgerPath } = setup();
    // Ledger anterior ao campo `pid`: entrada crua, sem pid.
    appendFileSync(ledgerPath, `${JSON.stringify({
      schemaVersion: 3,
      ts: new Date().toISOString(),
      run: "r1",
      kind: "agent",
      event: "created",
      agent_id: "default",
      session_id: "r1",
      credentialRef: "CRED_KEY",
      seq: 1,
    })}\n`);
    const observed = summarizeLocks(ledger)[0]!;

    expect(observed.pid).toBeUndefined();
    expect(observed.alive).toBe(false);
    expect(releaseObservedLock(ledger, audit, observed).released).toBe(true);
  });

  test("idade vem no resumo e é formatada", () => {
    const { ledger, audit } = setup();
    acquireAgentLock(ledger, audit, {
      run: "r1", agent_id: "default", session_id: "r1", ...identity, pid: process.pid,
    });
    const now = Date.now() + 3 * 3_600_000 + 41 * 60_000;
    const observed = summarizeLocks(ledger, () => true, now)[0]!;

    expect(observed.created_at).toBeDefined();
    expect(observed.ageMs).toBeGreaterThan(3 * 3_600_000);
    expect(formatAge(observed.ageMs as number)).toContain("3h");
  });
});
