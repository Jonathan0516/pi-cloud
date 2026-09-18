import { describe, expect, it } from "vitest";
import { isProxyToken, mintProxyToken, verifyProxyToken } from "../src/index.ts";

const SECRET = "test-secret-that-is-long-enough";

describe("proxy tokens", () => {
	it("round-trips claims and enforces expiry", () => {
		const now = 1_700_000_000_000;
		const token = mintProxyToken(SECRET, { tenant: "acme", session: "s1" }, 60, now);
		expect(isProxyToken(token)).toBe(true);
		expect(verifyProxyToken(SECRET, token, now + 1_000)).toEqual({
			ok: true,
			claims: { tenant: "acme", session: "s1", exp: 1_700_000_060, iat: 1_700_000_000 },
		});
		expect(verifyProxyToken(SECRET, token, now + 61_000)).toEqual({ ok: false, reason: "token expired" });
	});

	it("rejects tampering, wrong secrets, and garbage", () => {
		const token = mintProxyToken(SECRET, { tenant: "acme", session: "s1" }, 60);
		const [prefix, payload, signature] = token.split(".") as [string, string, string];
		const forged = Buffer.from(JSON.stringify({ t: "other", s: "s1", e: 9_999_999_999, i: 1 })).toString("base64url");
		expect(verifyProxyToken(SECRET, `${prefix}.${forged}.${signature}`)).toMatchObject({
			ok: false,
			reason: "bad signature",
		});
		expect(verifyProxyToken("another-secret-that-is-long", token)).toMatchObject({
			ok: false,
			reason: "bad signature",
		});
		expect(verifyProxyToken(SECRET, "sk-not-a-token")).toMatchObject({ ok: false, reason: "malformed token" });
		expect(verifyProxyToken(SECRET, `${prefix}.${payload}`)).toMatchObject({ ok: false });
		expect(() => mintProxyToken("short", { tenant: "a", session: "b" }, 60)).toThrow();
	});
});
