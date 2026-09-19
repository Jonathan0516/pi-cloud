/**
 * Node-local bundle cache: `<cacheDir>/<version>/` holds the extracted files once they have been
 * verified against the manifest, plus a `.manifest.json` and a `.complete` marker written last.
 * A version is immutable, so a complete directory is trusted without re-hashing; an incomplete one
 * (a crash mid-extraction) is rebuilt. Extraction goes through a temporary directory and a rename,
 * so two workers materializing the same version at once cannot observe each other's partial work.
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	type BundleFiles,
	type BundleManifest,
	BundleValidationError,
	bundleVersion,
	isBundleVersion,
	validateBundlePath,
	verifyBundleFiles,
} from "./manifest.ts";

const MANIFEST_FILE = ".manifest.json";
const COMPLETE_FILE = ".complete";

export interface CachedBundle {
	version: string;
	dir: string;
	manifest: BundleManifest;
}

export function bundleCacheDir(cacheDir: string, version: string): string {
	if (!isBundleVersion(version)) throw new BundleValidationError(`Not a bundle version: ${version}`);
	return join(cacheDir, version);
}

/** The cached bundle when its directory is complete, else undefined. */
export async function readCachedBundle(cacheDir: string, version: string): Promise<CachedBundle | undefined> {
	const dir = bundleCacheDir(cacheDir, version);
	try {
		await stat(join(dir, COMPLETE_FILE));
		const manifest = JSON.parse(await readFile(join(dir, MANIFEST_FILE), "utf8")) as BundleManifest;
		if (bundleVersion(manifest) !== version)
			throw new BundleValidationError(`Cached manifest of ${version} is corrupt`);
		return { version, dir, manifest };
	} catch (error) {
		if (error instanceof BundleValidationError) throw error;
		return undefined;
	}
}

/**
 * Write a verified bundle into the cache. The files are checked against the manifest and the
 * manifest against the version before anything is renamed into place.
 */
export async function materializeBundle(
	cacheDir: string,
	version: string,
	manifest: BundleManifest,
	files: BundleFiles,
): Promise<CachedBundle> {
	const cached = await readCachedBundle(cacheDir, version);
	if (cached !== undefined) return cached;
	if (bundleVersion(manifest) !== version) throw new BundleValidationError(`Manifest does not hash to ${version}`);
	verifyBundleFiles(manifest, files);

	const dir = bundleCacheDir(cacheDir, version);
	const staging = `${dir}.staging-${process.pid}-${Date.now()}`;
	await rm(staging, { recursive: true, force: true });
	await mkdir(staging, { recursive: true });
	try {
		for (const [path, bytes] of files) {
			const target = join(staging, validateBundlePath(path));
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, bytes);
		}
		await writeFile(join(staging, MANIFEST_FILE), JSON.stringify(manifest));
		await writeFile(join(staging, COMPLETE_FILE), new Date().toISOString());
		try {
			await rename(staging, dir);
		} catch (error) {
			// Another worker finished first; its copy is byte-identical.
			if ((await readCachedBundle(cacheDir, version)) === undefined) throw error;
		}
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
	return { version, dir, manifest };
}
