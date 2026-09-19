/**
 *   tsx --tsconfig tsconfig.json packages/cloud-gateway/src/main.ts                       serve
 *   tsx --tsconfig tsconfig.json packages/cloud-gateway/src/main.ts keys create --tenant t --user u [--label l]
 *   tsx --tsconfig tsconfig.json packages/cloud-gateway/src/main.ts keys list [--tenant t]
 *   tsx --tsconfig tsconfig.json packages/cloud-gateway/src/main.ts keys revoke <key-hash>
 *   tsx --tsconfig tsconfig.json packages/cloud-gateway/src/main.ts bundles publish <dir> --tenant t [--set-default]
 *   tsx --tsconfig tsconfig.json packages/cloud-gateway/src/main.ts bundles list --tenant t
 *   tsx --tsconfig tsconfig.json packages/cloud-gateway/src/main.ts bundles set-default <version> --tenant t
 *
 * `keys create` prints the key once; the database keeps only its hash.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
	type BundleFiles,
	clearTenantBundle,
	listBundles,
	publishBundle,
	setTenantBundle,
	tenantDefaultBundle,
} from "@earendil-works/pi-cloud-worker";
import { createPostgresClient } from "@earendil-works/pi-session-backend-postgres";
import { createApiKey, listApiKeys, revokeApiKey } from "./auth.ts";
import { loadGatewayConfig } from "./config.ts";
import { prepareGatewayDatabase, startGateway } from "./server.ts";

function option(argv: string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	return index === -1 ? undefined : argv[index + 1];
}

/** Every file under `dir`, keyed by its POSIX path relative to it. Dotfiles and dot-directories are skipped. */
async function readBundleDirectory(dir: string): Promise<BundleFiles> {
	const files = new Map<string, Uint8Array>();
	const walk = async (current: string): Promise<void> => {
		for (const entry of await readdir(current, { withFileTypes: true })) {
			if (entry.name.startsWith(".")) continue;
			const path = join(current, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile())
				files.set(relative(dir, path).split(sep).join("/"), new Uint8Array(await readFile(path)));
		}
	};
	if (!(await stat(dir)).isDirectory()) throw new Error(`Not a directory: ${dir}`);
	await walk(dir);
	if (files.size === 0) throw new Error(`No files under ${dir}`);
	return files;
}

async function bundles(argv: string[]): Promise<void> {
	const config = loadGatewayConfig();
	const sql = createPostgresClient({
		url: config.databaseUrl,
		schema: config.schema,
		max: 1,
		applicationName: "pi-cloud-gateway-cli",
	});
	try {
		await prepareGatewayDatabase(sql, config);
		const [command, ...rest] = argv;
		const tenant = option(rest, "--tenant");
		if (!tenant) throw new Error("bundles commands require --tenant");
		switch (command) {
			case "publish": {
				const dir = rest[0];
				if (!dir || dir.startsWith("--")) throw new Error("bundles publish requires a directory");
				const { bundle, created } = await publishBundle(sql, tenant, await readBundleDirectory(dir));
				if (rest.includes("--set-default")) await setTenantBundle(sql, tenant, bundle.version);
				console.log(bundle.version);
				console.error(
					`${created ? "published" : "already published"} ${bundle.manifest.files.length} file(s), ${bundle.size} bytes${rest.includes("--set-default") ? "; now the tenant default" : ""}`,
				);
				return;
			}
			case "list": {
				const current = await tenantDefaultBundle(sql, tenant);
				for (const bundle of await listBundles(sql, tenant)) {
					console.log(
						`${bundle.version}\t${bundle.manifest.files.length} files\t${bundle.size} bytes\t${bundle.createdAt.toISOString()}${bundle.version === current?.version ? "\tdefault" : ""}`,
					);
				}
				return;
			}
			case "set-default": {
				const version = rest[0];
				if (!version || version.startsWith("--")) throw new Error("bundles set-default requires a version");
				await setTenantBundle(sql, tenant, version);
				console.log(`default bundle for ${tenant} is now ${version}`);
				return;
			}
			case "clear-default": {
				console.log((await clearTenantBundle(sql, tenant)) ? "cleared" : "no default was set");
				return;
			}
			default:
				throw new Error("bundles subcommands: publish, list, set-default, clear-default");
		}
	} finally {
		await sql.end();
	}
}

async function keys(argv: string[]): Promise<void> {
	const config = loadGatewayConfig();
	const sql = createPostgresClient({
		url: config.databaseUrl,
		schema: config.schema,
		max: 1,
		applicationName: "pi-cloud-gateway-cli",
	});
	try {
		await prepareGatewayDatabase(sql, config);
		const [command, ...rest] = argv;
		switch (command) {
			case "create": {
				const tenant = option(rest, "--tenant");
				const user = option(rest, "--user");
				if (!tenant || !user) throw new Error("keys create requires --tenant and --user");
				const created = await createApiKey(sql, { tenant, user }, option(rest, "--label"));
				console.log(created.key);
				console.error(`created key ${created.keyHash.slice(0, 12)}… for ${tenant}/${user}; shown once`);
				return;
			}
			case "list": {
				for (const key of await listApiKeys(sql, option(rest, "--tenant"))) {
					console.log(
						`${key.keyHash}\t${key.tenant}\t${key.user}\t${key.label ?? ""}\t${key.createdAt.toISOString()}\t${key.revokedAt ? "revoked" : "active"}`,
					);
				}
				return;
			}
			case "revoke": {
				const hash = rest[0];
				if (!hash) throw new Error("keys revoke requires the key hash");
				console.log((await revokeApiKey(sql, hash)) ? "revoked" : "no active key with that hash");
				return;
			}
			default:
				throw new Error("keys subcommands: create, list, revoke");
		}
	} finally {
		await sql.end();
	}
}

async function serve(): Promise<void> {
	const gateway = await startGateway(loadGatewayConfig());
	await new Promise<void>((resolve) => {
		for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => resolve());
	});
	await gateway.close();
}

const [command, ...rest] = process.argv.slice(2);
const run = command === "keys" ? keys(rest) : command === "bundles" ? bundles(rest) : serve();
run.then(
	() => process.exit(0),
	(error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	},
);
