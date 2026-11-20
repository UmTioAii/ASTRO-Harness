import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadHomeState, saveHomeState } from "../src/home-state";
import {
  TERMS_LINES,
  TERMS_UNATTENDED_NOTICE,
  TERMS_VERSION,
  ensureTermsAccepted,
  formatTerms,
  loadTermsAcceptance,
  saveTermsAcceptance,
  termsChoice,
  termsPrompt,
  type TermsAcceptance,
} from "../src/terms";
import { parseCommand } from "../src/chat/commands";
import { runRepl, type ChatSession } from "../src/chat/repl";
import { runCommand } from "../src/tui/commands";

const ISO = "2026-11-20T12:00:00.000Z";

function stateFile(): string {
  return join(mkdtempSync(join(tmpdir(), "astro-terms-")), "home", "state.json");
}

describe("termos de uso (#479)", () => {
  test("texto: cinco linhas em português, versionado e presente no doc dono", () => {
    expect(TERMS_LINES).toHaveLength(5);
    for (const line of TERMS_LINES) expect(line.trim()).not.toBe("");
    expect(TERMS_VERSION).toMatch(/^\d+$/);
    // Sem rede: o texto vive no repositório e não pode divergir do doc da revisão jurídica.
    const doc = readFileSync(join(import.meta.dir, "..", "docs", "terms.md"), "utf8");
    for (const line of TERMS_LINES) expect(doc).toContain(line);
  });

  test("primeiro run: pergunta, Enter aceita e grava versão + data ISO (0600/0700 no POSIX)", async () => {
    const path = stateFile();
    const asked: Array<TermsAcceptance | undefined> = [];
    const decision = await ensureTermsAccepted({
      path,
      ask: (previous) => { asked.push(previous); return termsChoice(""); }, // Enter
      now: () => new Date(ISO),
    });
    expect(asked).toEqual([undefined]);
    expect(decision).toEqual({ kind: "accepted", record: { version: TERMS_VERSION, acceptedAt: ISO } });
    expect(loadTermsAcceptance(path)).toEqual({ version: TERMS_VERSION, acceptedAt: ISO });
    // O registro é só versão + data: nenhuma credencial nem dado pessoal.
    const raw = JSON.parse(readFileSync(path, "utf8")) as { terms: Record<string, unknown> };
    expect(Object.keys(raw.terms).sort()).toEqual(["acceptedAt", "version"]);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    }
  });

  test("mesma versão não pergunta e o registro sobrevive a um novo run", async () => {
    const path = stateFile();
    await ensureTermsAccepted({ path, ask: () => true, now: () => new Date(ISO) });
    // Nova instância/processo: relê do disco e nem chama o canal interativo.
    const decision = await ensureTermsAccepted({
      path,
      ask: () => { throw new Error("não devia perguntar de novo"); },
    });
    expect(decision).toEqual({ kind: "current", record: { version: TERMS_VERSION, acceptedAt: ISO } });
  });

  test("versão nova pergunta de novo, mostra a anterior e substitui o registro", async () => {
    const path = stateFile();
    saveTermsAcceptance({ version: "0", acceptedAt: "2020-01-01T00:00:00.000Z" }, path);
    let previous: TermsAcceptance | undefined;
    const decision = await ensureTermsAccepted({
      path,
      now: () => new Date(ISO),
      ask: (accepted) => { previous = accepted; return true; },
    });
    expect(previous).toEqual({ version: "0", acceptedAt: "2020-01-01T00:00:00.000Z" });
    expect(decision.kind).toBe("accepted");
    expect(loadTermsAcceptance(path)).toEqual({ version: TERMS_VERSION, acceptedAt: ISO });
  });

  test("recusa: não grava nada e não altera o estado existente", async () => {
    const path = stateFile();
    expect(await ensureTermsAccepted({ path, ask: () => false })).toEqual({ kind: "declined" });
    expect(existsSync(path)).toBe(false);
    // Com estado existente (trust), o arquivo fica byte a byte igual.
    saveHomeState({ version: 1, trust: { folders: ["/projeto"] }, migrations: { providers: true, trust: true } }, path);
    const before = readFileSync(path, "utf8");
    expect(await ensureTermsAccepted({ path, ask: () => false })).toEqual({ kind: "declined" });
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(loadHomeState(path).terms).toBeUndefined();
  });

  test("sem canal interativo: segue sem perguntar, sem gravar e de forma determinística", async () => {
    const path = stateFile();
    expect(await ensureTermsAccepted({ path })).toEqual({ kind: "unattended" });
    expect(await ensureTermsAccepted({ path })).toEqual({ kind: "unattended" });
    expect(existsSync(path)).toBe(false);
    expect(TERMS_UNATTENDED_NOTICE).toContain(`versão ${TERMS_VERSION}`);
  });

  test("prompt e /terms: texto completo, só Enter aceita, espaço não aceita, EOF recusa", async () => {
    const prompt = termsPrompt();
    for (const line of TERMS_LINES) expect(prompt).toContain(line);
    expect(termsPrompt({ version: "0", acceptedAt: ISO })).toContain("versão 0");
    expect(termsChoice("")).toBe(true);
    // Enter é a única aceitação: espaço, tab e qualquer resposta não vazia recusam.
    for (const answer of [" ", "   ", "\t", "\n", "n", "s", null, undefined]) expect(termsChoice(answer)).toBe(false);

    const pending = formatTerms(undefined);
    for (const line of TERMS_LINES) expect(pending).toContain(line);
    expect(pending).toContain("ainda não aceito");
    expect(formatTerms({ version: TERMS_VERSION, acceptedAt: ISO })).toContain(ISO);
  });

  test("state.json: legado sem terms continua válido; registro inválido é erro citando o caminho", () => {
    const path = stateFile();
    saveHomeState({ version: 1, trust: { folders: [] }, migrations: { providers: false, trust: false } }, path);
    expect(loadTermsAcceptance(path)).toBeUndefined();
    const base = { version: 1, trust: { folders: [] }, migrations: { providers: false, trust: false } };
    const invalids = [
      { ...base, terms: { version: "1" } },
      { ...base, terms: { version: "1", acceptedAt: "ontem" } },
      { ...base, terms: { version: "", acceptedAt: ISO } },
      { ...base, terms: { version: "1", acceptedAt: ISO, user: "alguém" } },
    ];
    for (const invalid of invalids) {
      writeFileSync(path, JSON.stringify(invalid));
      expect(() => loadTermsAcceptance(path)).toThrow(path);
    }
  });

  test("/terms: comando reconhecido e lido por inteiro na TUI", async () => {
    expect(parseCommand("/terms")).toEqual({ kind: "terms" });
    const path = stateFile();
    const pending = await runCommand({ kind: "terms" }, {} as ChatSession, {}, { termsPath: path });
    expect(pending.entries).toHaveLength(1);
    for (const line of TERMS_LINES) expect(pending.entries[0]!.text).toContain(line);
    expect(pending.entries[0]!.text).toContain("ainda não aceito");
    saveTermsAcceptance({ version: TERMS_VERSION, acceptedAt: ISO }, path);
    expect((await runCommand({ kind: "terms" }, {} as ChatSession, {}, { termsPath: path })).entries[0]!.text).toContain(ISO);
  });

  test("/terms relata estado ilegível em vez de derrubar a TUI e o REPL", async () => {
    const path = stateFile();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"terms":');

    // TUI: entrada de aviso, não exceção.
    const tui = await runCommand({ kind: "terms" }, {} as ChatSession, {}, { termsPath: path });
    expect(tui.entries).toHaveLength(1);
    for (const line of TERMS_LINES) expect(tui.entries[0]!.text).toContain(line);
    expect(tui.entries[0]!.text).toContain("ilegível");
    expect(tui.entries[0]!.text).toContain(path);
    // A mensagem cita o caminho, nunca o conteúdo do arquivo (I-03).
    writeFileSync(path, '{"apiKey":"valor-ilegivel-nao-pode-vazar"');
    const redacted = await runCommand({ kind: "terms" }, {} as ChatSession, {}, { termsPath: path });
    expect(redacted.entries[0]!.text).not.toContain("valor-ilegivel-nao-pode-vazar");

    // Caminho que não é arquivo (home presente, estado ilegível) também não derruba.
    const notAFile = join(mkdtempSync(join(tmpdir(), "astro-terms-")), "state.json");
    mkdirSync(notAFile);
    expect((await runCommand({ kind: "terms" }, {} as ChatSession, {}, { termsPath: notAFile })).entries[0]!.text)
      .toContain(notAFile);

    // REPL: imprime o aviso e segue vivo para o /exit.
    const previous = process.env.ASTRO_HOME;
    process.env.ASTRO_HOME = dirname(path);
    const outputs: string[] = [];
    const lines = ["/terms", "/exit"];
    try {
      await runRepl({ close: () => {} } as unknown as ChatSession, {
        read: async () => lines.shift() ?? null,
        write: (text) => { outputs.push(text); },
      });
    } finally {
      if (previous === undefined) delete process.env.ASTRO_HOME;
      else process.env.ASTRO_HOME = previous;
    }
    expect(outputs.join("\n")).toContain("ilegível");
    expect(outputs.join("\n")).not.toContain("valor-ilegivel-nao-pode-vazar");
  });
});
