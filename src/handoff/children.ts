/**
 * Child handoff and resume tiers (ADR-0036, #602): the happy path returns an
 * unpersisted summary; an exceptional child writes one bounded
 * HandoffArtifactV1 at the 512-token level, never the parent transcript.
 */
import { estimateTokens } from "../tokens";
import {
  CHILD_OUTPUT_FORMAT_MAX_CHARS, HandoffError, buildHandoffArtifact, handoffId,
  type HandoffArtifactV1, type HandoffBudget, type HandoffCompaction, type HandoffDraft,
  type HandoffSourceRefs,
} from "./types";

/** Compact ceiling for a child brief, the same level as `compactDraft`. */
export const CHILD_BRIEF_MAX_TOKENS = 512;

/** The five fields a parent may hand a child; free text never includes a transcript. */
export interface ChildBrief { objective: string; outputFormat: string; constraints: string[]; whatWasTried: string[]; boundaries: string[]; }

export interface BoundedChildBrief { brief: ChildBrief; compaction: HandoffCompaction; truncated: boolean; originalTokens: number; returnedTokens: number; }

export interface ChildHandoffInput {
  run: string; from: string; to: string; sourceStep: number; budgetSpent: HandoffBudget; brief: ChildBrief;
  fromProfile?: string; toProfile?: string; sourceRefs?: HandoffSourceRefs;
}

const FIELD_CHARS = 200, ITEM_CHARS = 120, MAX_ITEMS = 4;
const serializedTokens = (value: unknown): number => estimateTokens(JSON.stringify(value));
const clip = (value: string, max = FIELD_CHARS): string => value.trim().slice(0, max);
const normalizeList = (values: readonly string[]): string[] =>
  values.map((value) => value.trim()).filter((value) => value.length > 0);
function clipList(values: readonly string[], field: string, dropped: Set<string>): string[] {
  const normalized = normalizeList(values);
  const clipped = normalized.slice(0, MAX_ITEMS).map((value) => clip(value, ITEM_CHARS)).filter((value) => value.length > 0);
  if (JSON.stringify(clipped) !== JSON.stringify(normalized)) dropped.add(field);
  return clipped;
}
const draftOf = (brief: ChildBrief): HandoffDraft => ({
  task: brief.objective, objective: brief.objective, decisions: brief.whatWasTried,
  constraints: brief.constraints, next_steps: brief.boundaries,
});

/**
 * Clips each field and list, then trims the serialized draft until it fits
 * `maxTokens`: `what was tried` first, then boundaries, constraints, objective
 * and output format. The clipping is measured on `JSON.stringify`, so newline,
 * control and surrogate escapes cannot inflate the 512-token level.
 */
export function boundChildBrief(brief: ChildBrief, maxTokens = CHILD_BRIEF_MAX_TOKENS): BoundedChildBrief {
  const dropped = new Set<string>();
  const objective = brief.objective.trim();
  const outputFormat = brief.outputFormat.trim() || "final text summary";
  const normalized: ChildBrief = {
    objective, outputFormat,
    constraints: normalizeList(brief.constraints),
    whatWasTried: normalizeList(brief.whatWasTried),
    boundaries: normalizeList(brief.boundaries),
  };
  const current: ChildBrief = {
    objective: clip(objective),
    outputFormat: clip(outputFormat, CHILD_OUTPUT_FORMAT_MAX_CHARS),
    constraints: clipList(normalized.constraints, "constraints", dropped),
    whatWasTried: clipList(normalized.whatWasTried, "decisions", dropped),
    boundaries: clipList(normalized.boundaries, "next_steps", dropped),
  };
  if (current.objective !== objective) dropped.add("objective");
  if (current.outputFormat !== outputFormat) dropped.add("child_output_format");
  const originalTokens = serializedTokens(normalized);
  while (serializedTokens(draftOf(current)) > maxTokens) {
    if (current.whatWasTried.length > 0) {
      current.whatWasTried = [];
      dropped.add("decisions");
    } else if (current.boundaries.length > 0) {
      current.boundaries = current.boundaries.slice(0, -1);
      dropped.add("next_steps");
    } else if (current.constraints.length > 0) {
      current.constraints = current.constraints.slice(0, -1);
      dropped.add("constraints");
    } else if (current.objective.length > 1) {
      current.objective = current.objective.slice(0, -1);
      dropped.add("objective");
    } else if (current.outputFormat.length > 1) {
      current.outputFormat = current.outputFormat.slice(0, -1);
      dropped.add("child_output_format");
    } else {
      break;
    }
  }
  const returnedTokens = serializedTokens(draftOf(current));
  if (returnedTokens > maxTokens) {
    throw new HandoffError("handoff_artifact_mismatch", `child brief exceeds ${maxTokens} tokens after clipping`);
  }
  const droppedFields = [...dropped];
  return {
    brief: current,
    compaction: droppedFields.length === 0
      ? { strategy: "none", droppedFields: [] }
      : { strategy: "truncate", droppedFields },
    truncated: droppedFields.length > 0,
    originalTokens,
    returnedTokens,
  };
}

/** Builds the exceptional handoff at the compact level; no parent transcript. */
export function buildChildHandoffArtifact(input: ChildHandoffInput): HandoffArtifactV1 {
  const bounded = boundChildBrief(input.brief);
  return buildHandoffArtifact({
    run: input.run, from: input.from, to: input.to, sourceStep: input.sourceStep,
    budgetSpent: input.budgetSpent, draft: draftOf(bounded.brief),
    childOutputFormat: bounded.brief.outputFormat, compaction: bounded.compaction,
    ...(bounded.truncated
      ? { truncation: { truncated: true, originalTokens: bounded.originalTokens, returnedTokens: bounded.returnedTokens } }
      : {}),
    ...(input.fromProfile === undefined ? {} : { fromProfile: input.fromProfile }),
    ...(input.toProfile === undefined ? {} : { toProfile: input.toProfile }),
    ...(input.sourceRefs === undefined ? {} : { sourceRefs: input.sourceRefs }),
  });
}

export type ChildResumeLevel = "L1" | "L2" | "L3";

const CHILD_RESUME_LEVELS: readonly string[] = ["L1", "L2", "L3"];

/** Boundary parser: model JSON must match the union exactly; unknown values are not a rebuild. */
export function parseChildResumeLevel(value: unknown): ChildResumeLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && CHILD_RESUME_LEVELS.includes(value)) return value as ChildResumeLevel;
  throw new HandoffError("handoff_mismatch", "invalid resume level; use L1, L2 or L3");
}

/** Context a resume may restore. The parent transcript is not a member. */
export type RestoredContext = "brief" | "child_session" | "journal";

export interface ChildResumeInput {
  /** Explicit parent request; omitted means L2 while the session is live. */
  requested?: ChildResumeLevel;
  /** Child run to reopen; required for L2 when no artifact carries it. */
  sessionId?: string;
  sessionAvailable: boolean;
  artifact?: HandoffArtifactV1;
}

export interface ChildResumePlan {
  level: ChildResumeLevel; source: "request" | "default" | "fallback"; restored: RestoredContext[];
  brief?: ChildBrief; childSession?: string; handoffId?: string;
  /** L3 only: the ledger interval the brief is rebuilt from. */
  sourceRefs?: HandoffSourceRefs;
  unavailable?: "artifact_missing" | "session_missing";
}

function briefFromArtifact(artifact: HandoffArtifactV1): ChildBrief {
  return {
    objective: artifact.objective, outputFormat: artifact.child_output_format ?? "final text summary",
    constraints: artifact.constraints, whatWasTried: artifact.decisions, boundaries: artifact.next_steps,
  };
}

/**
 * L1 reruns the brief and is honored only on an explicit parent request; L2
 * reopens the live child session by default; L3 rebuilds from artifact +
 * journal and is the automatic fallback when the session is gone.
 */
export function planChildResume(input: ChildResumeInput): ChildResumePlan {
  const requested = parseChildResumeLevel(input.requested);
  const artifact = input.artifact;
  const brief = artifact === undefined ? undefined : briefFromArtifact(artifact);
  const common = {
    ...(brief === undefined ? {} : { brief }),
    ...(artifact === undefined ? {} : { handoffId: handoffId(artifact) }),
  };
  if (requested === "L1") {
    return { level: "L1", source: "request", restored: brief === undefined ? [] : ["brief"], ...common };
  }
  if ((requested === "L2" || requested === undefined) && input.sessionAvailable) {
    const session = input.sessionId ?? artifact?.run;
    if (session === undefined) {
      return {
        level: "L2", source: requested === "L2" ? "request" : "default",
        restored: [], unavailable: "session_missing",
      };
    }
    return {
      level: "L2", source: requested === "L2" ? "request" : "default",
      restored: brief === undefined ? ["child_session"] : ["brief", "child_session"],
      ...common, childSession: session,
    };
  }
  if (artifact === undefined) {
    return {
      level: "L3", source: requested === "L3" ? "request" : "fallback",
      restored: [], unavailable: "artifact_missing",
    };
  }
  return {
    level: "L3", source: requested === "L3" ? "request" : "fallback",
    restored: ["brief", "journal"], ...common,
    ...(artifact.source_refs === undefined ? {} : { sourceRefs: artifact.source_refs }),
  };
}
