import { type ConformanceCase, createExecutionEnvConformance } from "@earendil-works/pi-agent-core/harness/env/testing";
import { describe, it } from "vitest";
import { createSandboxFixture, describeSandbox } from "./support.ts";

function registerConformance(name: string, cases: readonly ConformanceCase[]): void {
	describeSandbox(name, () => {
		for (const group of new Set(cases.map((testCase) => testCase.group))) {
			describe(group, () => {
				for (const testCase of cases.filter((candidate) => candidate.group === group)) {
					it(testCase.name, () => testCase.run());
				}
			});
		}
	});
}

registerConformance(
	"OpenSandboxExecutionEnv conformance",
	createExecutionEnvConformance(createSandboxFixture, { settleTimeoutMs: 20_000 }),
);
