# 040 — WP5: a pasted redirect that looks right must not be silently refused

**Issue:** bug report. **PR base:** `dev`. **Screenshot:** not required.

## The defect

`parseCallbackInput` (`callback-server.ts:273-300`) tries three shapes in
order: a parseable URL, a string containing `code=`, then a raw code with an
optional `#state`.

The URL branch reads `url.searchParams` only:

```ts
const url = new URL(value);
return {
  kind: "url",
  code: url.searchParams.get("code") ?? undefined,
  state: url.searchParams.get("state") ?? undefined,
};
```

A redirect that returns its parameters in the **fragment** —
`http://localhost:1455/callback#code=abc&state=xyz` — parses as a valid URL,
yields no `code`, and is rejected by `submitManualLoginCode:1345` with
"no authorization code found in input".

From the operator's chair this is the worst possible failure: they pasted the
entire address bar, exactly as the hint text instructed
(`prov.pasteRedirectHint`: "copy the full URL from its address bar"), and were
told their paste contains no code.

Note the asymmetry that makes this a bug rather than a limitation: the **raw**
branch already understands `code#state`, and the **query** branch already
strips a leading `#` (`value.replace(/^[?#]/, "")`). Fragments are understood
everywhere except the one shape most likely to be pasted.

## The change

One function, `callback-server.ts:277-283`:

```diff
 try {
   const url = new URL(value);
-  return {
-    kind: "url",
-    code: url.searchParams.get("code") ?? undefined,
-    state: url.searchParams.get("state") ?? undefined,
-  };
+  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
+  // A redirect may return its parameters in the fragment. Query wins when both
+  // are present: it is the authorization-code response location, and a fragment
+  // is the shape an implicit-grant response uses.
+  return {
+    kind: "url",
+    code: url.searchParams.get("code") ?? fragment.get("code") ?? undefined,
+    state: url.searchParams.get("state") ?? fragment.get("state") ?? undefined,
+  };
 } catch {
   // Not a URL - check for query string format
 }
```

### What must not change

- **`kind` stays `"url"`.** That is what makes state mandatory
  (`callback-server.ts:252`, `index.ts:1347-1350`). A fragment-carried
  response is still an authorization response and gets the same CSRF
  treatment as a query-carried one. Downgrading it to `raw` to skip the state
  check would be a security regression wearing a convenience costume.
- **Only `code` and `state` are read.** Never `access_token`, never
  `id_token`. This repo does not implement the implicit grant and a paste
  path must not become the place it appears.
- **Query beats fragment** when both exist, so no existing paste changes
  meaning.

## Test

Extend `tests/oauth-manual-code.test.ts`, which already has a
`parseCallbackInput kinds` block (`:32-52`):

| Input | Expected |
|---|---|
| `http://localhost:1455/callback#code=abc&state=xyz` | `kind: "url"`, code `abc`, state `xyz` |
| `http://localhost:1455/callback?code=q&state=s#code=f&state=f` | query wins: `q` / `s` |
| `http://localhost:1455/callback#code=abc` | `kind: "url"`, code `abc`, **state undefined** |
| `http://localhost:1455/callback#access_token=t` | no code — a token fragment is not an authorization response |

Plus one end-to-end assertion through `submitManualLoginCode`: a
fragment-carried paste with a **mismatched** state is still rejected with the
state-mismatch error, proving the fix did not open a CSRF hole.

And one gap the inventory surfaced that belongs here because it is the same
function: `code#state` in the **raw** branch has no test today despite being
supported. Add it.

## Acceptance

- A fragment-carried redirect URL completes a login.
- A fragment-carried redirect with a bad state is refused, with the specific
  state-mismatch message.
- `bun run typecheck`, `bun run test` green.
