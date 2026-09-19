/**
 * Which bundle a session runs with, decided once at worker start.
 *
 * The pin lives in the session (`cloud.bundle/version`); the tenant's current default lives in
 * `tenant_bundles`. The upgrade rule moves an idle session to the default only when the default
 * registers every entry type the session holds. Whatever version wins is materialized into the
 * node cache (verified against its manifest) and loaded into harness resources.
 */

import type { Context } from "@earendil-works/pi-agent-core";
import type { PostgresClient, PostgresOpenSession } from "@earendil-works/pi-session-backend-postgres";
import { type CachedBundle, materializeBundle, readCachedBundle } from "../bundles/cache.ts";
import { type BundleResources, loadBundleResources } from "../bundles/resources.ts";
import { readBundle, readBundleWithFiles, readSessionEntryTypes, tenantDefaultBundle } from "../bundles/store.ts";
import { type BundleUpgradePlan, planBundleUpgrade } from "../bundles/upgrade.ts";
import type { CloudConfig } from "../config.ts";
import { hasOpenOperation } from "../server/recovery.ts";
import { sessionBundleVersion, sessionTenant } from "../session-values.ts";

export interface SessionBundle {
	plan: BundleUpgradePlan;
	cached: CachedBundle | undefined;
	resources: BundleResources | undefined;
	/** The pin moved during this start; a remembered sandbox carries the old mount and must go. */
	changed: boolean;
}

export async function resolveSessionBundle(
	sql: PostgresClient,
	session: PostgresOpenSession,
	config: CloudConfig,
	context: Context,
	log: (message: string) => void = (message) => console.error(message),
): Promise<SessionBundle> {
	const sessionId = session.metadata.id;
	const pinned = (await session.getValue(sessionBundleVersion, context))?.value;
	const tenant = (await session.getValue(sessionTenant, context))?.value;
	const tenantDefault = tenant === undefined ? undefined : await tenantDefaultBundle(sql, tenant);
	const plan = planBundleUpgrade({
		pinned,
		tenantDefault: tenantDefault?.version,
		hasOpenOperation: pinned === tenantDefault?.version ? false : await hasOpenOperation(sql, sessionId),
		sessionTypes:
			pinned === tenantDefault?.version
				? { entryTypes: [], customTypes: [] }
				: await readSessionEntryTypes(sql, sessionId),
		defaultRegisters: tenantDefault?.manifest.registers,
	});
	let changed = false;
	if (plan.action === "adopt" || plan.action === "upgrade") {
		await session.setValue(sessionBundleVersion, plan.version, context);
		changed = plan.action === "upgrade";
		log(`Bundle ${plan.action}: ${plan.version.slice(0, 12)} (${plan.reason})`);
	} else if (plan.action === "keep" && tenantDefault !== undefined && plan.version !== tenantDefault.version) {
		log(
			`Bundle kept at ${plan.version.slice(0, 12)}; tenant default is ${tenantDefault.version.slice(0, 12)} (${plan.reason})`,
		);
	}
	if (plan.version === undefined) return { plan, cached: undefined, resources: undefined, changed };

	let cached = await readCachedBundle(config.bundleCacheDir, plan.version);
	if (cached === undefined) {
		const stored = await readBundleWithFiles(sql, plan.version);
		if (stored === undefined) {
			log(`Bundle ${plan.version.slice(0, 12)} is pinned but missing from the store; running bare`);
			return { plan, cached: undefined, resources: undefined, changed };
		}
		cached = await materializeBundle(config.bundleCacheDir, plan.version, stored.manifest, stored.files);
		log(`Bundle ${plan.version.slice(0, 12)} materialized into ${cached.dir}`);
	} else {
		// The manifest is trusted from the cache; confirm the version still exists so a deleted bundle is noticed.
		if ((await readBundle(sql, plan.version)) === undefined)
			log(`Bundle ${plan.version.slice(0, 12)} no longer in the store; using the cached copy`);
	}
	const resources = await loadBundleResources(cached.dir, plan.version, cached.manifest);
	for (const diagnostic of resources.diagnostics) log(`Bundle ${plan.version.slice(0, 12)}: ${diagnostic}`);
	return { plan, cached, resources, changed };
}
