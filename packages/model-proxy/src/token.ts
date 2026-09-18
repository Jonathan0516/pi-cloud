import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "pimp1";

/** Who a proxy token admits. Workers present it as their API key; the proxy holds the real ones. */
export interface ProxyTokenClaims {
	tenant: string;
	/** Session the worker serves. Requests must carry it in `x-pi-session`. */
	session: string;
	/** Expiry, seconds since the Unix epoch. */
	exp: number;
	/** Issued at, seconds since the Unix epoch. */
	iat: number;
}

export type VerifyResult = { ok: true; claims: ProxyTokenClaims } | { ok: false; reason: string };

function base64url(input: Buffer | string): string {
	return Buffer.from(input).toString("base64url");
}

function sign(secret: string, payload: string): string {
	return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Mint a token. `ttlSeconds` bounds how long a worker can call the proxy without a new token. */
export function mintProxyToken(
	secret: string,
	claims: { tenant: string; session: string },
	ttlSeconds: number,
	now: number = Date.now(),
): string {
	if (secret.length < 16) throw new Error("Model proxy secret must be at least 16 characters");
	const iat = Math.floor(now / 1000);
	const payload = base64url(JSON.stringify({ t: claims.tenant, s: claims.session, e: iat + ttlSeconds, i: iat }));
	return `${PREFIX}.${payload}.${sign(secret, payload)}`;
}

export function isProxyToken(value: string): boolean {
	return value.startsWith(`${PREFIX}.`);
}

/** Verify signature and expiry. Never throws. */
export function verifyProxyToken(secret: string, token: string, now: number = Date.now()): VerifyResult {
	const parts = token.split(".");
	if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, reason: "malformed token" };
	const [, payload, signature] = parts as [string, string, string];
	const expected = sign(secret, payload);
	const given = Buffer.from(signature, "base64url");
	const wanted = Buffer.from(expected, "base64url");
	if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return { ok: false, reason: "bad signature" };
	let decoded: { t?: unknown; s?: unknown; e?: unknown; i?: unknown };
	try {
		decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
	} catch {
		return { ok: false, reason: "malformed payload" };
	}
	if (typeof decoded.t !== "string" || typeof decoded.s !== "string") return { ok: false, reason: "malformed claims" };
	if (typeof decoded.e !== "number" || typeof decoded.i !== "number") return { ok: false, reason: "malformed claims" };
	if (decoded.e * 1000 <= now) return { ok: false, reason: "token expired" };
	return { ok: true, claims: { tenant: decoded.t, session: decoded.s, exp: decoded.e, iat: decoded.i } };
}
