/**
 * Child handoff and resume tiers (ADR-0036, #602): the happy path returns an
 * unpersisted summary; an exceptional child writes one bounded
 * HandoffArtifactV1 at the 512-token level, never the parent transcript.
 */
import { estimateTokens } from "../tokens";
import { compactDraft } from "./compact";
import {
  buildHandoffArtifact,
  handoffId,
  type HandoffArtifactV1,
  type HandoffBudget,
  type HandoffCompaction,
  type HandoffDraft,
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

const FIELD_CHARS = 200, FORMAT_CHARS = 160, ITEM_CHARS = 120, MAX_ITEMS = 4;
const clip = (value: string, max = FIELD_CHARS): string => value.trim().slice(0, max);
const clipList = (values: readonly string[]): string[] =>
  values.slice(0, MAX_ITEMS).map((value) => clip(value, ITEM_CHARS)).filter((value) => value.length > 0);
const draftOf = (brief: ChildBrief): HandoffDraft => ({
  task: brief.objective, objective: brief.objective, decisions: brief.whatWasTried,
  constraints: brief.constraints, next_steps: brief.boundaries,
});

/**
 * Clips each field and list, then lets `compactDraft` drop `what was tried`
 * when the 512-token ceiling is still exceeded. Objective, output format and
 * constraints survive; boundaries only shrink by clipping.
 */
export function boundChildBrief(brief: ChildBrief, maxTokens = CHILD_BRIEF_MAX_TOKENS): BoundedChildBrief {
  const normalized: ChildBrief = {
    objective: brief.objective.trim(), outputFormat: brief.outputFormat.trim() || "final text summary",
    constraints: brief.constraints.map((value) => value.trim()),
    whatWasTried: brief.whatWasTried.map((value) => value.trim()),
    boundaries: brief.boundaries.map((value) => value.trim()),
  };
  const clipped: ChildBrief = {
    objective: clip(normalized.objective), outputFormat: clip(normalized.outputFormat, FORMAT_CHARS),
    constraints: clipList(normalized.constraints), whatWasTried: clipList(normalized.whatWasTried),
    boundaries: clipList(normalized.boundaries),
  };
  const originalTokens = estimateTokens(JSON.stringify(normalized));
  const compacted = compactDraft(draftOf(clipped), maxTokens);
  const bounded: ChildBrief = {
    objective: clipped.objective, outputFormat: clipped.outputFormat,
    constraints: compacted.draft.constraints, whatWasTried: compacted.draft.decisions,
    boundaries: compacted.draft.next_steps,
  };
  const returnedTokens = estimateTokens(JSON.stringify(draftOf(bounded)));
  const droppedFields = compacted.compaction.droppedFields;
  const truncated = JSON.stringify(clipped) !== JSON.stringify(normalized) || droppedFields.length > 0;
  return {
    brief: bounded,
    compaction: truncated ? { strategy: "truncate", droppedFields } : { strategy: "none", droppedFields: [] },
    truncated,
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

/** Context a resume may restore. The parent transcript is not a member. */
export type RestoredContext = "brief" | "child_session" | "journal";

export interface ChildResumeInput { requested?: ChildResumeLevel; sessionAvailable: boolean; artifact?: HandoffArtifactV1; }

export interface ChildResumePlan {
  level: ChildResumeLevel; source: "request" | "default" | "fallback"; restored: RestoredContext[];
  brief?: ChildBrief; childSession?: string; handoffId?: string;
  /** L3 only: the ledger interval the brief is rebuilt from. */
  sourceRefs?: HandoffSourceRefs; unavailable?: "artifact_missing";
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
  const artifact = input.artifact;
  const brief = artifact === undefined ? undefined : briefFromArtifact(artifact);
  const common = {
    ...(brief === undefined ? {} : { brief }),
    ...(artifact === undefined ? {} : { handoffId: handoffId(artifact) }),
  };
  if (input.requested === "L1") {
    return { level: "L1", source: "request", restored: brief === undefined ? [] : ["brief"], ...common };
  }
  if ((input.requested === "L2" || input.requested === undefined) && input.sessionAvailable) {
    return {
      level: "L2", source: input.requested === "L2" ? "request" : "default",
      restored: brief === undefined ? ["child_session"] : ["brief", "child_session"], ...common,
      ...(artifact === undefined ? {} : { childSession: artifact.run }),
    };
  }
  if (artifact === undefined) {
    return { level: "L3", source: input.requested === "L3" ? "request" : "fallback", restored: [], unavailable: "artifact_missing" };
  }
  return {
    level: "L3", source: input.requested === "L3" ? "request" : "fallback",
    restored: ["brief", "journal"], ...common,
    ...(artifact.source_refs === undefined ? {} : { sourceRefs: artifact.source_refs }),
  };
}
