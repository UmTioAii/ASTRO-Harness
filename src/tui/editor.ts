/** Completions do editor da TUI: `/` comandos e `@` arquivos (puro). */
import { searchFiles } from "./files";
import { listWindow } from "./viewport";

export interface CommandInfo {
  readonly name: string;
  readonly description: string;
}

export const COMMANDS: readonly CommandInfo[] = [
  { name: "/help", description: "mostra esta ajuda" },
  { name: "/model", description: "lista ou troca o modelo" },
  { name: "/mode", description: "lista ou troca o modo de permissão (bypass pede confirm)" },
  { name: "/shell", description: "lista os shells do host; grava shell.default com confirm" },
  { name: "/config", description: "abre a tela de configuração do harness" },
  { name: "/providers", description: "lista os providers configurados" },
  { name: "/provider", description: "gerencia perfis (add/edit/remove/use); na tela, → lista modelos e enter troca o modelo" },
  { name: "/session", description: "resumo da sessão atual" },
  { name: "/details", description: "detalhes: provider, uptime, tokens, custo" },
  { name: "/sessions", description: "lista, renomeia e exclui as sessões gravadas" },
  { name: "/resume", description: "retoma uma sessão gravada" },
  { name: "/save", description: "grava a sessão em disco" },
  { name: "/export", description: "exporta a conversa em Markdown" },
  { name: "/init", description: "cria AGENTS.md no diretório atual" },
  { name: "/usage", description: "uso da sessão (turnos, tokens, custo) e budget" },
  { name: "/log", description: "mostra o log da sessão (com /log <n>, só as últimas n linhas)" },
  { name: "/terms", description: "termos de uso por inteiro e a versão aceita" },
  { name: "/theme", description: "lista ou troca o tema (dark, light, contrast)" },
  { name: "/compact", description: "resume o histórico em um sumário" },
  { name: "/summarize", description: "alias de /compact" },
  { name: "/attach", description: "anexa arquivo ou diretório (completion de path)" },
  { name: "/paste", description: "anexa o texto do clipboard" },
  { name: "/detach", description: "lista ou remove anexos pendentes" },
  { name: "/new", description: "limpa o histórico (alias de /clear)" },
  { name: "/clear", description: "limpa o histórico" },
  { name: "/exit", description: "encerra a sessão" },
];

/** Itens que o painel deve mostrar para a linha atual (sem corte fixo). */
export function completionItems(
  line: string,
  commands: readonly CommandInfo[] = COMMANDS,
  files: readonly string[] = [],
): string[] {
  if (line.startsWith("/") && !line.includes(" ")) {
    return commands.filter((command) => command.name.startsWith(line)).map((command) => command.name);
  }
  const at = line.lastIndexOf("@");
  if (at >= 0 && (at === 0 || /\s/.test(line[at - 1]!))) {
    const query = line.slice(at + 1);
    if (!/\s/.test(query)) return searchFiles(files, query).map((file) => `@${file}`);
  }
  return [];
}

/** Descrição de um comando para o painel de sugestões. */
export function commandDescription(name: string, commands: readonly CommandInfo[] = COMMANDS): string | undefined {
  return commands.find((command) => command.name === name)?.description;
}

export const MAX_VISIBLE_SUGGESTIONS = 8;

/** Janela de rolagem [start, end) que mantém `selected` visível. */
export function suggestionWindow(length: number, selected: number, max = MAX_VISIBLE_SUGGESTIONS): { start: number; end: number } {
  return listWindow(length, selected, max);
}

/** Aplica a escolha à linha: comando substitui tudo; arquivo mantém o texto anterior. */
export function applyCompletion(line: string, choice: string): string {
  if (line.startsWith("/")) return choice;
  const at = line.lastIndexOf("@");
  if (at < 0) return line;
  return `${line.slice(0, at)}${choice} `;
}

export type EnterAction = "apply-completion" | "run";

/**
 * Semântica do Enter com o menu de sugestões aberto (#471): sem sugestão
 * ativa, linha já igual ao comando destacado ou linha com argumento → "run";
 * prefixo de comando de barra → "apply-completion" (1º Enter aplica na linha,
 * 2º Enter roda). Completions de `@arquivo` ficam em "run" (fora de escopo).
 */
export function enterAction(line: string, suggestion: string | undefined): EnterAction {
  if (suggestion === undefined) return "run";
  if (!line.startsWith("/") || line.includes(" ")) return "run";
  return line === suggestion ? "run" : "apply-completion";
}
