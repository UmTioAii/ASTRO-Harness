/**
 * Budget and quota alarms (#64, #514, #595): the first transition shows a toast,
 * repeats go to the in-memory /log. Moved out of `app.tsx` by the TUI slice.
 */
import { useEffect, useMemo, useRef } from "react";
import { budgetSegment, quotaSegment } from "../chat/usage";
import type { BudgetStatus } from "../budget";
import type { QuotaStatus } from "../quota";
import type { ChatSession } from "../chat/repl";

export interface TuiAlarmsOptions {
  session: ChatSession;
  /** Session status tick: recomputes both segments when it changes. */
  status: unknown;
  log(line: string): void;
  toast(toast: { kind: "warning"; text: string }): void;
}

export function useAlarms(options: TuiAlarmsOptions): { budget: BudgetStatus | undefined; quota: QuotaStatus | undefined } {
  const budget = useMemo(() => {
    try {
      return options.session.budgetStatus?.();
    } catch {
      return undefined;
    }
  }, [options.session, options.status]);

  const budgetAlarm = useRef(false);
  useEffect(() => {
    const high = budget !== undefined && (budget.warning || budget.exhausted || budget.ceilingHit);
    if (high && budget !== undefined) {
      // first warning band goes to the toast only (transient); repeats go to /log (#514, #64, doc §/log)
      if (budgetAlarm.current) options.log(`custo alto · ${budgetSegment(budget)}`);
      else options.toast({ kind: "warning", text: `custo alto · ${budgetSegment(budget)}` });
    }
    budgetAlarm.current = high;
  }, [budget]);

  const quota = useMemo(() => {
    try {
      return options.session.quotaStatus?.();
    } catch {
      return undefined;
    }
  }, [options.session, options.status]);

  const quotaAlarm = useRef(false);
  useEffect(() => {
    const high = quota !== undefined && (quota.warning || quota.exhausted);
    if (high && quota !== undefined) {
      // same rule as budget: first time toast only, repeats in /log (#514, doc §/log)
      if (quotaAlarm.current) options.log(quotaSegment(quota));
      else options.toast({ kind: "warning", text: quotaSegment(quota) });
    }
    quotaAlarm.current = high;
  }, [quota]);

  return { budget, quota };
}
