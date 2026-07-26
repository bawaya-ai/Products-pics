// ── Request time budget — turns the route's budget from advisory into ENFORCED ──
// The scrape route computes one deadline (epoch ms) and threads it down to every
// provider call; each call's timeout is clamped to what's actually left, so a slow
// provider can never starve the stages (or the guaranteed-result fallback) after it.

/** Timeout for one provider call: at most `max`, at most what's left (minus 2s headroom), never under 3s. */
export function capTimeout(max: number, deadlineAt?: number): number {
  if (!deadlineAt) return max;
  return Math.max(3000, Math.min(max, deadlineAt - Date.now() - 2000));
}

/** Remaining ms of the request budget (Infinity when no deadline was set). */
export function remainingMs(deadlineAt?: number): number {
  return deadlineAt ? deadlineAt - Date.now() : Infinity;
}
