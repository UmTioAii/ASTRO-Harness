/**
 * Child-to-child message bus (ADR-0036, #602): opt-in per run, direct
 * addressing only, bounded per run. Every message is copied to the parent as a
 * sanitized `agent.message` event; a message is data, never a scope or grant.
 */
import { ARTIFACT_REF_PATTERN } from "../internal-ids";
import { sanitizePromptText } from "../sanitize-external";
export const MAX_BUS_MESSAGES = 32;
export const MAX_BUS_BYTES = 8_192;
export const MAX_MESSAGE_CHARS = 500;
export const MAX_MESSAGE_BYTES = 1_024;
export type AgentBusRefusal =
  | "bus_broadcast_refused" | "bus_parent_address" | "bus_unknown_recipient" | "bus_target_unavailable"
  | "bus_ambiguous_recipient" | "bus_self_address" | "bus_invalid_body" | "bus_message_too_large"
  | "bus_limit_exceeded" | "bus_invalid_artifact" | "bus_unknown_sender" | "bus_duplicate_execution"
  | "bus_depth_exceeded" | "bus_scope_exceeded";
export class AgentBusError extends Error {
  readonly code: AgentBusRefusal;
  constructor(code: AgentBusRefusal, message: string) { super(message); this.name = "AgentBusError"; this.code = code; }
}
const refuse = (code: AgentBusRefusal, message: string): never => { throw new AgentBusError(code, message); };
export interface BusAudit {
  append(event: { run: string; agent?: string; tipo: string; payload?: Record<string, unknown> }): unknown;
}
export interface BusParticipant {
  agent: string;
  execution: string;
  depth: number;
  scope: readonly string[];
}
export interface AgentMessage { id: string; from: string; fromExecution: string; to: string; body: string; artifact?: string; bytes: number; at: string; }
export interface AgentMessageBusOptions {
  run: string;
  parentAgent: string;
  roster: readonly string[];
  eligible: readonly string[];
  rootScope: readonly string[];
  audit: BusAudit;
  maxMessages?: number;
  maxBytes?: number;
}
export interface BusSendInput { to: string; body: string; artifact?: string; }
const BROADCAST = /^(?:\*|all|everyone|broadcast|@all)$/i;
const ADDRESS_SEPARATORS = /[,;\s]/;
export class AgentMessageBus {
  readonly #run: string;
  readonly #parentAgent: string;
  readonly #roster: ReadonlySet<string>;
  readonly #eligible: ReadonlySet<string>;
  readonly #rootScope: ReadonlySet<string>;
  readonly #audit: BusAudit;
  readonly #maxMessages: number;
  readonly #maxBytes: number;
  readonly #participants = new Map<string, BusParticipant>();
  readonly #mailboxes = new Map<string, AgentMessage[]>(); // messages per execution
  readonly #pending = new Map<string, AgentMessage[]>(); // addressed to an agent not started yet
  #count = 0; #bytes = 0; #seq = 0;
  constructor(opts: AgentMessageBusOptions) {
    this.#run = opts.run; this.#parentAgent = opts.parentAgent;
    this.#roster = new Set(opts.roster);
    this.#eligible = new Set(opts.eligible);
    this.#rootScope = new Set(opts.rootScope);
    this.#audit = opts.audit;
    this.#maxMessages = opts.maxMessages ?? MAX_BUS_MESSAGES;
    this.#maxBytes = opts.maxBytes ?? MAX_BUS_BYTES;
  }
  list(): readonly BusParticipant[] { return [...this.#participants.values()]; }
  register(input: BusParticipant): BusParticipant {
    if (input.depth !== 1) refuse("bus_depth_exceeded", "child-to-child messages are depth one only");
    if (this.#participants.has(input.execution)) refuse("bus_duplicate_execution", "this execution is already on the bus");
    if (!input.scope.every((tool) => this.#rootScope.has(tool))) refuse("bus_scope_exceeded", "the child scope exceeds the parent scope");
    const participant: BusParticipant = { ...input, scope: [...input.scope] };
    this.#participants.set(input.execution, participant);
    if (this.#executionsOf(input.agent).length === 1) {
      const queued = this.#pending.get(input.agent);
      if (queued !== undefined) { this.#mailboxes.set(input.execution, queued); this.#pending.delete(input.agent); }
    }
    return participant;
  }
  send(from: { execution: string; agent: string }, input: BusSendInput): AgentMessage {
    const sender = this.#sender(from);
    const to = typeof input.to === "string" ? input.to.trim() : "";
    if (to === this.#parentAgent) refuse("bus_parent_address", "the parent is the default channel; return instead");
    if (to === "" || BROADCAST.test(to) || ADDRESS_SEPARATORS.test(to)) refuse("bus_broadcast_refused", "direct addressing only; name one sibling agent");
    if (to === sender.agent) refuse("bus_self_address", "a child cannot address itself");
    if (!this.#roster.has(to)) refuse("bus_unknown_recipient", "recipient is not part of this run");
    if (!this.#eligible.has(to)) refuse("bus_target_unavailable", "recipient cannot use the bus in this run");
    if (typeof input.body !== "string") refuse("bus_invalid_body", "message body must be text");
    const body = sanitizePromptText(input.body).trim();
    const artifact = input.artifact;
    if (artifact !== undefined && (typeof artifact !== "string" || !ARTIFACT_REF_PATTERN.test(artifact))) {
      refuse("bus_invalid_artifact", "artifact must be an artifact store ref");
    }
    if (body === "" && artifact === undefined) refuse("bus_invalid_body", "send a message or an artifact ref");
    const bytes = new TextEncoder().encode(body).length;
    if (body.length > MAX_MESSAGE_CHARS || bytes > MAX_MESSAGE_BYTES) refuse("bus_message_too_large", "message exceeds the note size; send an artifact ref instead");
    const recipients = this.#executionsOf(to);
    if (recipients.length > 1) refuse("bus_ambiguous_recipient", "more than one execution uses this agent name");
    if (this.#count >= this.#maxMessages || this.#bytes + bytes > this.#maxBytes) refuse("bus_limit_exceeded", "the run's message bus is full");
    const message: AgentMessage = {
      id: `m${++this.#seq}`, from: sender.agent, fromExecution: sender.execution, to, body, bytes,
      at: new Date().toISOString(), ...(artifact === undefined ? {} : { artifact }),
    };
    const mailbox = recipients[0] === undefined
      ? this.#pending.get(to) ?? []
      : this.#mailboxes.get(recipients[0]) ?? [];
    if (recipients[0] === undefined) this.#pending.set(to, mailbox);
    else this.#mailboxes.set(recipients[0], mailbox);
    mailbox.push(message);
    this.#count += 1;
    this.#bytes += bytes;
    this.#audit.append({ run: this.#run, agent: sender.agent, tipo: "agent.message", payload: {
      id: message.id, from: message.from, to: message.to, fromExecution: message.fromExecution,
      bytes: message.bytes, body: message.body, ...(message.artifact === undefined ? {} : { artifact: message.artifact }),
    } });
    return message;
  }
  inbox(from: { execution: string; agent: string }): readonly AgentMessage[] {
    const sender = this.#sender(from);
    const messages = this.#mailboxes.get(sender.execution) ?? [];
    this.#mailboxes.delete(sender.execution);
    return messages;
  }
  #sender(from: { execution: string; agent: string }): BusParticipant {
    const participant = this.#participants.get(from.execution);
    if (participant === undefined || participant.agent !== from.agent) {
      throw new AgentBusError("bus_unknown_sender", "this execution is not on the run's message bus");
    }
    return participant;
  }
  #executionsOf(agent: string): string[] {
    return [...this.#participants.values()].filter((entry) => entry.agent === agent).map((entry) => entry.execution);
  }
}
