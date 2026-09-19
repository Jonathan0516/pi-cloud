/**
 * The upgrade rule (design §5.6): a session moves to its tenant's current bundle only at an idle
 * boundary, and only when the new bundle understands every entry type the session already holds.
 * A pinned version protects work in progress; it must not pin a session to a fossil forever.
 */

export interface BundleUpgradeInput {
	/** Version the session is pinned to; undefined when it never had one. */
	pinned: string | undefined;
	/** The tenant's current default; undefined when the tenant has none. */
	tenantDefault: string | undefined;
	/** The session has durable operation state a worker would resume. */
	hasOpenOperation: boolean;
	/** `type` and `custom_type` values present in the session's entries. */
	sessionTypes: { entryTypes: readonly string[]; customTypes: readonly string[] };
	/** What the tenant default registers; undefined when it could not be read. */
	defaultRegisters: { entryTypes: readonly string[]; customTypes: readonly string[] } | undefined;
}

export type BundleUpgradePlan =
	| { action: "none"; version: undefined; reason: string }
	| { action: "keep"; version: string; reason: string }
	| { action: "adopt"; version: string; reason: string }
	| { action: "upgrade"; version: string; from: string; reason: string };

export function planBundleUpgrade(input: BundleUpgradeInput): BundleUpgradePlan {
	const { pinned, tenantDefault } = input;
	if (tenantDefault === undefined) {
		return pinned === undefined
			? { action: "none", version: undefined, reason: "tenant has no bundle" }
			: { action: "keep", version: pinned, reason: "tenant has no default; keeping the pinned version" };
	}
	if (pinned === tenantDefault) return { action: "keep", version: pinned, reason: "already on the tenant default" };
	if (input.hasOpenOperation) {
		return pinned === undefined
			? { action: "none", version: undefined, reason: "operation open; not adopting a bundle mid-run" }
			: { action: "keep", version: pinned, reason: "operation open; upgrades happen at idle boundaries" };
	}
	if (input.defaultRegisters === undefined) {
		return pinned === undefined
			? { action: "none", version: undefined, reason: "tenant default unreadable" }
			: { action: "keep", version: pinned, reason: "tenant default unreadable" };
	}
	const missingEntryTypes = input.sessionTypes.entryTypes.filter(
		(type) => !input.defaultRegisters?.entryTypes.includes(type),
	);
	const missingCustomTypes = input.sessionTypes.customTypes.filter(
		(type) => !input.defaultRegisters?.customTypes.includes(type),
	);
	if (missingEntryTypes.length > 0 || missingCustomTypes.length > 0) {
		const missing = [...missingEntryTypes, ...missingCustomTypes.map((type) => `custom:${type}`)].join(", ");
		return pinned === undefined
			? { action: "none", version: undefined, reason: `tenant default does not register ${missing}` }
			: { action: "keep", version: pinned, reason: `tenant default does not register ${missing}` };
	}
	return pinned === undefined
		? { action: "adopt", version: tenantDefault, reason: "idle session without a bundle" }
		: { action: "upgrade", version: tenantDefault, from: pinned, reason: "idle and every entry type is registered" };
}
