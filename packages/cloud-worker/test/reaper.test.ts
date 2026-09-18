import { describe, expect, it } from "vitest";
import { planTakeovers, type TakeoverCandidate } from "../src/server/reaper.ts";

function candidate(sessionId: string, overrides: Partial<TakeoverCandidate> = {}): TakeoverCandidate {
	return { sessionId, hasOpenOperation: true, failures: 0, faulted: false, ...overrides };
}

describe("takeover planning", () => {
	it("takes at most the per-tick budget and defers the rest to the next tick", () => {
		const plan = planTakeovers([candidate("a"), candidate("b"), candidate("c"), candidate("d")], {
			perTick: 2,
			failureThreshold: 3,
		});
		expect(plan.take).toEqual(["a", "b"]);
		expect(plan.deferredBudget).toEqual(["c", "d"]);
		expect(plan.deferredIdle).toEqual([]);
		expect(plan.skippedFaulted).toEqual([]);
	});

	it("leaves idle sessions to the next presentation instead of spawning a worker for nothing", () => {
		const plan = planTakeovers([candidate("idle", { hasOpenOperation: false }), candidate("busy")], {
			perTick: 5,
			failureThreshold: 3,
		});
		expect(plan.take).toEqual(["busy"]);
		expect(plan.deferredIdle).toEqual(["idle"]);
	});

	it("skips faulted sessions and those at the failure threshold", () => {
		const plan = planTakeovers(
			[candidate("faulted", { faulted: true }), candidate("thrice", { failures: 3 }), candidate("fresh")],
			{ perTick: 5, failureThreshold: 3 },
		);
		expect(plan.take).toEqual(["fresh"]);
		expect(plan.skippedFaulted).toEqual(["faulted", "thrice"]);
	});

	it("resumes sessions that never failed before the ones that did", () => {
		const plan = planTakeovers(
			[candidate("flaky", { failures: 2 }), candidate("once", { failures: 1 }), candidate("clean")],
			{ perTick: 2, failureThreshold: 3 },
		);
		expect(plan.take).toEqual(["clean", "once"]);
		expect(plan.deferredBudget).toEqual(["flaky"]);
	});

	it("returns an empty plan when nothing expired", () => {
		expect(planTakeovers([], { perTick: 2, failureThreshold: 3 })).toEqual({
			take: [],
			deferredIdle: [],
			skippedFaulted: [],
			deferredBudget: [],
		});
	});
});
