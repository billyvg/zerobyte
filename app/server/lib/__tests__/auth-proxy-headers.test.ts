import { describe, expect, test } from "vitest";
import { auth } from "~/server/lib/auth";

describe("auth behind a reverse proxy", () => {
	// better-auth 1.7 changed the default to false. Without it, a request that reaches the
	// container over plain http from a TLS-terminating proxy resolves an `http://` base URL,
	// so SSO callback URLs and passkey origins no longer match the public `https://` site.
	test("trusts X-Forwarded-Proto/Host for the per-request base URL", () => {
		expect(auth.options.advanced?.trustedProxyHeaders).toBe(true);
		expect(auth.options.baseURL).toMatchObject({ protocol: "auto" });
	});
});
