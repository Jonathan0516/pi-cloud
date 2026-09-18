/**
 * Takeover policy for expired leases. Pure, so the storm limit and the circuit breaker are unit
 * tested without a database; the supervisor feeds it what it read and executes what it returns.
 */

export interface TakeoverCandidate {
	sessionId: string;
	/** The session has durable operation state a new worker would resume. */
	hasOpenOperation: boolean;
	failures: number;
	faulted: boolean;
}

export interface TakeoverPlan {
	/** Sessions to take over now, in priority order, at most `perTick`. */
	take: string[];
	/** Idle sessions: nothing to resume, so the next presentation that asks takes them over lazily. */
	deferredIdle: string[];
	/** Sessions past the failure threshold; left alone until an operator clears the fault. */
	skippedFaulted: string[];
	/** Sessions that would exceed this tick's budget; the next tick sees them again. */
	deferredBudget: string[];
}

export interface TakeoverPolicy {
	/** Takeovers one node starts per tick. Bounds the recovery storm after a node dies. */
	perTick: number;
	/** Failed resumes after which a session is left alone. */
	failureThreshold: number;
}

export function planTakeovers(candidates: readonly TakeoverCandidate[], policy: TakeoverPolicy): TakeoverPlan {
	const plan: TakeoverPlan = { take: [], deferredIdle: [], skippedFaulted: [], deferredBudget: [] };
	// Sessions that failed before go last, so one flaky session cannot starve healthy ones.
	const ordered = [...candidates].sort((left, right) => left.failures - right.failures);
	for (const candidate of ordered) {
		if (candidate.faulted || candidate.failures >= policy.failureThreshold) {
			plan.skippedFaulted.push(candidate.sessionId);
			continue;
		}
		if (!candidate.hasOpenOperation) {
			plan.deferredIdle.push(candidate.sessionId);
			continue;
		}
		if (plan.take.length >= policy.perTick) {
			plan.deferredBudget.push(candidate.sessionId);
			continue;
		}
		plan.take.push(candidate.sessionId);
	}
	return plan;
}
