/**
 * Declarative agent creation (#602, ADR-0036 §2): the harness matches a named
 * agent's `when` against the turn's active model. Prompt text is never parsed
 * and no free-form expression exists; the matcher only reads config and model
 * facts, so the same turn always resolves the same rule.
 */
import type { AgentWhenConfig, NamedAgentConfig } from "./core/config";

/** Facts a `when` rule is matched against: the model that runs the turn. */
export interface ActiveModelFacts {
  provider: string;
  /** Composite identity as declared in config, `provider/id`. */
  model: string;
  tags: readonly string[];
}

/**
 * Every predicate present must hold (AND). A semantically empty predicate set
 * never matches: config validation rejects it, and `[].every(...)` would be
 * vacuously true, so a hand-built `{ tags: [] }` must not fire on every turn.
 */
export function whenMatches(when: AgentWhenConfig, active: ActiveModelFacts): boolean {
  const tags = when.tags ?? [];
  if (tags.length === 0 && when.provider === undefined && when.model === undefined) return false;
  if (when.provider !== undefined && when.provider !== active.provider) return false;
  if (when.model !== undefined && when.model !== active.model) return false;
  if (tags.length > 0 && !tags.every((tag) => active.tags.includes(tag))) return false;
  return true;
}

/**
 * At most one declared agent fires per turn. Last match wins in declaration
 * order, mirroring `shell.rules` (#599): a later, more specific rule overrides
 * an earlier, broader one.
 */
export function matchDeclaredAgent(
  agents: Readonly<Record<string, NamedAgentConfig>> | undefined,
  active: ActiveModelFacts,
): { name: string; agent: NamedAgentConfig } | undefined {
  let match: { name: string; agent: NamedAgentConfig } | undefined;
  for (const [name, agent] of Object.entries(agents ?? {})) {
    if (agent.when !== undefined && whenMatches(agent.when, active)) match = { name, agent };
  }
  return match;
}
