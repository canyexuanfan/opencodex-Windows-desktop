import { describe, expect, test } from "bun:test";
import {
  REDACTED_SECRET,
  redactHeaders,
  redactSecretString,
  redactSecrets,
  redactUrlForLog,
} from "../src/lib/redact";

describe("redactSecretString", () => {
  test("masks bearer, api, access, refresh, and profile values", () => {
    const input = [
      "Authorization: Bearer access-token-value-123456",
      "api_key=sk-secret-provider-key",
      "accessToken=access-live-value",
      "refresh_token=refresh-live-value",
      "clientSecret=client-secret-live-value",
      "profile arn:aws:codewhisperer:us-east-1:123456789012:profile/demo",
    ].join("\n");

    const redacted = redactSecretString(input);
    expect(redacted).toContain(`Bearer ${REDACTED_SECRET}`);
    expect(redacted).toContain(`api_key=${REDACTED_SECRET}`);
    expect(redacted).toContain(`accessToken=${REDACTED_SECRET}`);
    expect(redacted).toContain(`refresh_token=${REDACTED_SECRET}`);
    expect(redacted).toContain(`clientSecret=${REDACTED_SECRET}`);
    expect(redacted).not.toContain("access-token-value-123456");
    expect(redacted).not.toContain("sk-secret-provider-key");
    expect(redacted).not.toContain("refresh-live-value");
    expect(redacted).not.toContain("client-secret-live-value");
    expect(redacted).not.toContain("arn:aws:codewhisperer");
  });

  test("preserves non-secret diagnostic text", () => {
    expect(redactSecretString("status=429 model=gpt-5.5")).toBe("status=429 model=gpt-5.5");
  });

  test("masks colon-labelled credentials echoed back by an upstream error", () => {
    // #1020 review: upstream 4xx bodies quote the offending header at us. The
    // `=` rules never fire for `header: value`, so a custom credential used to
    // survive into the client-visible error text.
    const input = [
      "x-api-key: customcredential123456",
      "X-Goog-Api-Key: another-live-credential",
      "client_secret: not-a-sk-shaped-value",
      "token: opaque-session-value",
    ].join("\n");

    const redacted = redactSecretString(input);
    expect(redacted).toContain(`x-api-key: ${REDACTED_SECRET}`);
    expect(redacted).toContain(`X-Goog-Api-Key: ${REDACTED_SECRET}`);
    expect(redacted).not.toContain("customcredential123456");
    expect(redacted).not.toContain("another-live-credential");
    expect(redacted).not.toContain("not-a-sk-shaped-value");
    expect(redacted).not.toContain("opaque-session-value");
  });

  test("leaves non-credential colon labels readable", () => {
    // The colon rule must not swallow ordinary diagnostics.
    expect(redactSecretString("model: gpt-5.5\nstatus: 429\nrequest: ocx-abc123"))
      .toBe("model: gpt-5.5\nstatus: 429\nrequest: ocx-abc123");
  });

  test("masks the WHOLE colon-labelled value, including delimiter-bearing forms", () => {
    // Re-review of the first fix: tokenizing the value on quotes, spaces, and
    // semicolons leaked every variant that contains one. A credential header's
    // value is the rest of the line, so that is what must be masked.
    expect(redactSecretString('x-api-key: "quotedcredential123456"'))
      .toBe(`x-api-key: ${REDACTED_SECRET}`);
    expect(redactSecretString("Authorization: Basic dXNlcjpwYXNz"))
      .toBe(`Authorization: ${REDACTED_SECRET}`);
    expect(redactSecretString("Cookie: session=secret-one; csrf=secret-two"))
      .toBe(`Cookie: ${REDACTED_SECRET}`);
  });

  test("keeps the Bearer scheme readable while masking its token", () => {
    // An auth scheme is diagnostically useful; the credential after it is not.
    expect(redactSecretString("Authorization: Bearer abcdefgh12345678"))
      .toBe(`Authorization: Bearer ${REDACTED_SECRET}`);
  });

  test("a Bearer-prefixed value cannot smuggle a credential past the header rule", () => {
    // Re-review history: the colon rule first EXEMPTED `Bearer` and left it to
    // a separate rule, so anything that rule could not parse escaped both — a
    // quoted value, one containing punctuation, or one under the length floor.
    // The scheme is now handled in the same pass, so the token after it is
    // always consumed whatever its shape.
    // The Bearer carve-out is also scoped to headers where a scheme is
    // meaningful; on x-api-key the word buys nothing and the value is masked
    // whole, which closed `x-api-key: Bearer first <secret>`.
    expect(redactSecretString('x-api-key: Bearer "smuggledcredential123456"'))
      .toBe(`x-api-key: ${REDACTED_SECRET}`);
    expect(redactSecretString("Authorization: Bearer custom:credential123456"))
      .toBe(`Authorization: Bearer ${REDACTED_SECRET}`);
    expect(redactSecretString("x-api-key: Bearer short"))
      .toBe(`x-api-key: ${REDACTED_SECRET}`);
    expect(redactSecretString("x-api-key: Bearer first secondsecret123456"))
      .toBe(`x-api-key: ${REDACTED_SECRET}`);
  });

  test("a suffix appended after the public marker is not trusted", () => {
    // `[REDACTED]` is a PUBLIC string: an upstream can emit it too. Treating it
    // as proof that a prefix was already sanitized let a credential ride along
    // behind it. Nothing in the value grants trust now.
    expect(redactSecretString("x-api-key: Bearer [REDACTED].smuggledcredential123456"))
      .toBe(`x-api-key: ${REDACTED_SECRET}`);
    expect(redactSecretString("x-api-key: [REDACTED],smuggledcredential123456"))
      .toBe(`x-api-key: ${REDACTED_SECRET}`);
    expect(redactSecretString("Authorization: Bearer abcdefgh12345678,smuggledcredential123456"))
      .toBe(`Authorization: Bearer ${REDACTED_SECRET}`);
  });

  test("nothing after a credential label survives, at any nesting depth", () => {
    // Four review rounds each found a new way to hide a credential inside
    // whatever the previous round chose to preserve: a second label, a
    // repeated scheme word, then a third token two levels deep. Preserving
    // attacker-controlled text next to a credential was the bug itself.
    expect(redactSecretString("Authorization: Bearer firstsecret123456 x-api-key: secondsecret123456"))
      .toBe(`Authorization: Bearer ${REDACTED_SECRET}`);
    expect(redactSecretString("Authorization: Bearer Bearer nestedcredential123456"))
      .toBe(`Authorization: Bearer ${REDACTED_SECRET}`);
    expect(redactSecretString("Authorization: Bearer a123456 Bearer b123456 c123456"))
      .toBe(`Authorization: Bearer ${REDACTED_SECRET}`);
  });

  test("colon look-alikes do not bypass credential-label recognition", () => {
    // A full-width or small-form colon reads as a separator to a human and to
    // whatever produced the error body, so matching only ASCII ":" was a
    // bypass rather than strictness.
    // The fold is a MATCHING view: the original separator byte is preserved.
    for (const colon of ["\uFF1A", "\uFE55", "\uFE13", "\u205A", "\u0589", "\u1361", "\u16EC", "\u1803"]) {
      expect(redactSecretString(`x-api-key${colon}unicodesecret123456`))
        .toBe(`x-api-key${colon}${REDACTED_SECRET}`);
    }
    expect(redactSecretString("x-api-key\u200B: secretcredential123456"))
      .toBe(`x-api-key\u200B: ${REDACTED_SECRET}`);
    expect(redactSecretString("Authorization\u2060: Basic dXNlcjpwYXNz"))
      .toBe(`Authorization\u2060: ${REDACTED_SECRET}`);
  });

  test("folding never rewrites an unrelated diagnostic", () => {
    // Normalizing the string itself turned `ratio∶1` into `ratio:1`. Offsets
    // map back to the original bytes so untouched text is byte-identical.
    const diagnostic = "model\u2236gpt-5.5 status\u205A429 ratio\u2236 1";
    expect(redactSecretString(diagnostic)).toBe(diagnostic);
  });

  test("a label disguised with homoglyphs or invisible characters is still recognized", () => {
    // Review kept finding another character that splits or spoofs the label.
    // The matching view now folds cross-script homoglyphs and drops every
    // default-ignorable code point, rather than growing another finite list.
    const disguised = [
      "x-api-k\u0435y",      // Cyrillic e
      "x-\u0430pi-key",      // Cyrillic a
      "x-api-ke\u034Fy",     // combining grapheme joiner
      "x-api-ke\u2066y",     // bidi isolate
      "x-api-ke\u2069y",     // pop directional isolate
      "x-api-ke\u061Cy",     // arabic letter mark
      "x-api-ke\u180Ey",     // mongolian vowel separator
    ];
    for (const label of disguised) {
      expect(redactSecretString(`${label}: secretcredential123456`))
        .toBe(`${label}: ${REDACTED_SECRET}`);
    }
  });

  test("a longer field name that merely ends with a credential label is untouched", () => {
    // `\b` matched after `-` and `_`, so these were redacted as if they were
    // the credential headers they only end with.
    expect(redactSecretString("not-authorization: public-diagnostic-value"))
      .toBe("not-authorization: public-diagnostic-value");
    expect(redactSecretString("internal_token: public-diagnostic-value"))
      .toBe("internal_token: public-diagnostic-value");
  });

  test("a pathological repeated-header line neither overflows nor leaks", () => {
    // The first rescan attempt recursed per match and blew the stack here.
    const line = "Authorization: Bearer tok ".repeat(3000);
    const redacted = redactSecretString(line);
    expect(redacted).not.toContain("Bearer tok");
  });

  test("text before a quoted header is kept; everything after it is not", () => {
    // The scheme word still says which auth failed. The trailing path is lost
    // deliberately — keeping it meant keeping an attacker-controlled suffix,
    // which is exactly what the earlier rounds kept getting wrong.
    expect(redactSecretString("failed with Authorization: Bearer secret-abc123 at /Users/example/secret.json"))
      .toBe(`failed with Authorization: Bearer ${REDACTED_SECRET}`);
  });

  test("a Bearer token never masks across a line break", () => {
    // `\s+` included newlines, so a header quoted with a trailing break masked
    // the first word of the NEXT line as if it were the token.
    expect(redactSecretString("Authorization: Bearer\nrequestidentifier123456 diagnostic"))
      .toBe(`Authorization: ${REDACTED_SECRET}\nrequestidentifier123456 diagnostic`);
  });

  test("masks each credential line independently without eating the next", () => {
    // End-of-line, not end-of-string: a multi-line error body must not collapse.
    expect(redactSecretString("x-api-key: one-secret\nmodel: gpt-5.5\ncookie: two=secret"))
      .toBe(`x-api-key: ${REDACTED_SECRET}\nmodel: gpt-5.5\ncookie: ${REDACTED_SECRET}`);
  });
});

describe("redactSecrets", () => {
  test("recursively masks sensitive keys and embedded secret strings", () => {
    const input = {
      ok: true,
      count: 3,
      headers: {
        Authorization: "Bearer nested-secret-token",
        "content-type": "application/json",
      },
      tokens: [
        { accessToken: "access-abc" },
        "refreshToken=refresh-abc",
      ],
      nested: {
        profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/demo",
      },
    };

    const redacted = redactSecrets(input) as typeof input;
    expect(redacted.ok).toBe(true);
    expect(redacted.count).toBe(3);
    expect(redacted.headers.Authorization).toBe(REDACTED_SECRET);
    expect(redacted.headers["content-type"]).toBe("application/json");
    expect(redacted.tokens[0].accessToken).toBe(REDACTED_SECRET);
    expect(redacted.tokens[1]).toBe(`refreshToken=${REDACTED_SECRET}`);
    expect(redacted.nested.profileArn).toBe(REDACTED_SECRET);
  });

  test("leaves dates and primitive non-secrets intact", () => {
    const date = new Date("2026-06-29T00:00:00.000Z");
    expect(redactSecrets(date)).toBe(date);
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(undefined)).toBeUndefined();
    expect(redactSecrets(42)).toBe(42);
  });
});

describe("redactHeaders", () => {
  test("masks sensitive headers and preserves safe metadata", () => {
    const redacted = redactHeaders(new Headers({
      Authorization: "Bearer header-token-value",
      Cookie: "session=secret",
      "Set-Cookie": "session=secret",
      "X-Api-Key": "sk-header-key",
      "Content-Type": "application/json",
      "X-Request-Id": "req_123",
    }));

    expect(redacted.authorization).toBe(REDACTED_SECRET);
    expect(redacted.cookie).toBe(REDACTED_SECRET);
    expect(redacted["set-cookie"]).toBe(REDACTED_SECRET);
    expect(redacted["x-api-key"]).toBe(REDACTED_SECRET);
    expect(redacted["content-type"]).toBe("application/json");
    expect(redacted["x-request-id"]).toBe("req_123");
  });

  test("supports plain header records", () => {
    const redacted = redactHeaders({
      "x-goog-api-key": "google-secret",
      accept: "application/json",
      "x-extra": undefined,
    });

    expect(redacted["x-goog-api-key"]).toBe(REDACTED_SECRET);
    expect(redacted.accept).toBe("application/json");
    expect(redacted).not.toHaveProperty("x-extra");
  });
});

describe("redactUrlForLog", () => {
  test("strips credentials, query, and hash from valid URLs", () => {
    expect(redactUrlForLog("https://user:pass@example.test/v1/models?api_key=sk-secret#frag"))
      .toBe("https://example.test/v1/models");
  });

  test("best-effort redacts invalid URL strings", () => {
    expect(redactUrlForLog("not a url?refreshToken=refresh-secret")).toBe("not a url");
  });
});
