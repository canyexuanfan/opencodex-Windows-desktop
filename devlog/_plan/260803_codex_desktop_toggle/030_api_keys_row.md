# WP4 — API keys out of the client-card grid

> "이 api 키는 박스로 두지말고 위쪽에 한 라인으로 빼자"
>
> "don't leave this API key as a box/card - pull it out to the top as a single line/row."

Independent of WP2/WP3. This is a layout and summary-semantics change; the
`/api/keys` read already returns the only fact this surface needs.

## IN / OUT

IN: `gui/src/pages/integrations/overview-clients.ts` (MODIFY),
`gui/src/pages/integrations/IntegrationsOverview.tsx` (MODIFY),
`gui/src/styles-integrations.css` (MODIFY),
`gui/src/i18n/en.ts` (MODIFY), `gui/src/i18n/ko.ts` (MODIFY),
`gui/src/i18n/ja.ts` (MODIFY), `gui/src/i18n/zh.ts` (MODIFY),
`gui/src/i18n/de.ts` (MODIFY), `gui/src/i18n/ru.ts` (MODIFY),
`gui/tests/integrations-overview-rows.test.ts` (MODIFY),
`gui/tests/overview-state-merge.test.ts` (MODIFY), and
`gui/tests/integrations-surfaces.test.tsx` (MODIFY). No implementation file is NEW.

OUT: `gui/src/pages/integrations/integration-api.ts` — `loadApiKeyCount`
already reduces `/api/keys` to `number | null` (`:283-287`); API and polling
semantics do not change. `gui/src/pages/integrations/IntegrationStateBadge.tsx`
— reuse its `unknown/current/absent` vocabulary. `src/`, `tests/`, and
`docs-site/` — this neither changes the management contract nor setup behavior.

## Why keys is not a card

Every grid card represents a client that can be detected, applied, stale, or
unsafe against client-owned configuration. Most carry a switch and a config
path; the exceptions still describe routing or a profile that can drift.

API keys have neither property. They cannot be installed as a client, toggled,
or drift from a config file. Their entire overview state is the count returned
by `loadApiKeyCount`: zero keys, N issued keys, or an unsettled read, plus a way
to open the keys tab. Painting that credential inventory as one peer in the
client grid is the asymmetry that caused both the orphaned card and the false
summary totals. The type boundary should now say the same thing as the layout.

## Row model — `overview-clients.ts`

`OverviewClientId` stops admitting `keys`. `buildOverviewRows` still owns the
normalization of all overview sources, but its result separates the credential
row from client rows instead of returning one mixed array (`:24-59`, `:153-176`,
`:352-397`).

```diff
 export type OverviewClientId =
   | "codex"
-  | "keys"
   | "claude"
   | "claudeDesktop"
   | "grok"
   | FileIntegrationClientId;

+export interface ApiKeysOverviewRow {
+  hash: "integrations/keys";
+  labelKey: TKey;
+  state: "unknown" | "absent" | "current";
+  detailKey: TKey | null;
+  detailVars: Record<string, string> | null;
+}
+
+export interface OverviewRows {
+  keysRow: ApiKeysOverviewRow;
+  rows: OverviewRow[];
+}

 /** API keys are issued or not; there is no config file to drift. */
-function keysRow(count: number | null): OverviewRow {
-  const base = {
-    id: "keys" as const,
-    hash: "integrations/keys",
-    labelKey: "integrations.tab.keys" as TKey,
-    toggle: null,
-    toggleBlocked: null,
-    togglePath: null,
-    status: null,
-    detail: null,
-  };
+function keysRow(count: number | null): ApiKeysOverviewRow {
+  const base = {
+    hash: "integrations/keys" as const,
+    labelKey: "integrations.tab.keys" as TKey,
+  };
   if (count === null) {
-    return { ...base, state: "unknown", installed: false, applied: false, detailKey: null, detailVars: null };
+    return { ...base, state: "unknown", detailKey: null, detailVars: null };
   }
   return {
     ...base,
     state: count > 0 ? "current" : "absent",
-    installed: true,
-    applied: count > 0,
     detailKey: count > 0 ? "integrations.detail.keyCount" : "integrations.detail.keyNone",
     detailVars: count > 0 ? { count: String(count) } : null,
   };
 }

-export function buildOverviewRows(sources: OverviewSources): OverviewRow[] {
+export function buildOverviewRows(sources: OverviewSources): OverviewRows {
   const nativeClaude = sources.native?.find(status => status.clientId === "claude");
   const nativeGrok = sources.native?.find(status => status.clientId === "grok");
   const statusByClient = new Map(sources.clients.map(status => [status.clientId, status]));
   const rows: OverviewRow[] = [
     codexRow(sources.codex),
-    keysRow(sources.keyCount),
     claudeRow(sources.claude, nativeClaude, sources.nativeSettled),
     claudeDesktopRow(sources.claudeDesktop),
     grokRow(sources.grok, nativeGrok, sources.nativeSettled),
   ];
   // Existing file-client loop stays byte-for-byte unchanged.
-  return rows;
+  return { keysRow: keysRow(sources.keyCount), rows };
 }
```

Also change the file docstring's “Five more sources join the grid” to “Four
more client sources join the grid; API keys return separately,” change
`OverviewRow`'s “other five” detail comment to “other four,” and replace the
catalog-order comment at `:352-356` with the actual client order: Codex, Claude,
Claude Desktop, Grok, then the file clients. Comments must not keep claiming
that keys joins the grid after the type no longer permits it.

`ApiKeysOverviewRow` deliberately has no `installed`, `applied`, `toggle`, or
`status`. Re-adding one of those fields would recreate the semantic leak this
phase removes. `gui/tests/overview-state-merge.test.ts` changes only its helper
to search `buildOverviewRows(...).rows`; native-state behavior is otherwise
untouched.

## Render — `IntegrationsOverview.tsx`

The row goes immediately **below the summary strip** and above onboarding,
notices, and the grid (`:433-498`). The summary is the page-level aggregate;
the keys row is one credential surface with one action. Putting keys above the
summary would promote one surface over the aggregate, while merging it into the
strip would make “Manage keys” look like a bulk-status control beside “Disable
all.” Below preserves aggregate → individual → client catalog hierarchy.

```diff
 import {
   buildOverviewRows,
   countOverviewRows,
+  type ApiKeysOverviewRow,
   type OverviewRow,
 } from "./overview-clients";

+/**
+ * Credentials are one explicit action, not a clickable client card.
+ *
+ * Do not stretch the title over this row. The card overlay exists because a
+ * card also contains a switch; this row has no nested-control problem to
+ * solve. A plain Manage keys button is the one tab stop, so its visible label,
+ * focus ring, Enter, and Space behavior all come from a native button.
+ */
+function ApiKeysRow({ row }: { row: ApiKeysOverviewRow }) {
+  const t = useT();
+  const detail = row.detailKey ? t(row.detailKey, row.detailVars ?? undefined) : null;
+  return (
+    <div className="integration-api-keys-row" data-client="keys">
+      <div className="integration-api-keys-copy">
+        <h4>{t(row.labelKey)}</h4>
+        {detail && <p className="integration-meta">{detail}</p>}
+      </div>
+      <IntegrationStateBadge state={row.state} installed />
+      <button
+        type="button"
+        className="btn btn-ghost"
+        onClick={() => navigateHash(row.hash)}
+      >
+        {t("integrations.action.manageKeys")}
+      </button>
+    </div>
+  );
+}

-  const rows = buildOverviewRows({
+  const { keysRow, rows } = buildOverviewRows({
     clients,
     clientsSettled,
     codex: codexResource.state.data ?? null,
     keyCount: keysResource.state.data ?? null,
     claude: claudeResource.state.data ?? null,
     claudeDesktop: claudeDesktopResource.state.data ?? null,
     grok: grokResource.state.data ?? null,
     native,
     nativeSettled,
   });
   const counts = countOverviewRows(rows);

       </div>

+      <ApiKeysRow row={keysRow} />
+
       <p className="page-sub">{t("integrations.onboarding")}</p>

       {/*
-        The grid used to disappear entirely when no FILE client was installed,
-        which now means hiding Codex, API keys, Claude and Grok because the
+        The grid used to disappear entirely when no FILE client was installed,
+        which means hiding Codex, Claude and Grok because the
         user has not installed OpenCode. The "nothing detected" panel is about
         the file clients specifically, so it sits BELOW the grid and says so
         instead of replacing everything.
       */}
```

The row itself has no click handler and no `tabIndex`. Its heading, count, and
badge remain readable in document order; only the native action button enters
the tab sequence, once, at the same visual position. This does not copy the
card's `::after` overlay, does not add a second `tabIndex={-1}` action, and
cannot swallow a future control through stacking order.

## CSS — `styles-integrations.css`

Insert after the summary rules (`:11-14`), before `.integration-cards`. This is
a full-width divider row, not `.integration-card` with `grid-column: 1 / -1`:
it has no raised background, surrounding border, radius, or card hover state.

```diff
 .integration-summary-label { font-size: var(--text-caption); color: var(--muted); }
 .integration-summary .btn { margin-left: auto; }

+/* API keys are credential inventory, not a client card. A bottom rule keeps
+   the full-width row in the page flow without making it an orphaned wide card. */
+.integration-api-keys-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; min-height: 44px; padding: 0 0 14px; border-bottom: 1px solid var(--border); margin-bottom: 14px; }
+.integration-api-keys-copy { display: flex; align-items: baseline; flex: 1 1 220px; min-width: 0; flex-wrap: wrap; gap: 4px 10px; }
+.integration-api-keys-copy h4,
+.integration-api-keys-copy .integration-meta { margin: 0; }
+.integration-api-keys-row .btn { margin-inline-start: auto; flex: 0 0 auto; }
```

`flex-wrap` is intentional: at 320-390 px, long German/Russian action copy may
move beside or below the badge instead of clipping. It remains one credential
row surface. At normal widths, `flex: 1 1 220px` keeps title/count together on
the left and badge/action on the right. The existing global `:focus-visible`
rule owns the button ring; the rendered keyboard check below proves it.

## Counts

Keys leave all four totals. `countOverviewRows(rows)` remains unchanged because
its input is now client rows only.

- `detected`: a keys API endpoint exists on every dashboard; that is not a
  detected client. Counting it makes the total increase even with zero keys.
- `applied`: issuing a credential is not applying opencodex to a client. Two
  keys are inventory, not two applied integrations — and the old code counted
  either number as exactly one anyway.
- `stale`: keys have no config file and cannot enter this state.
- `unknown`: a failed `/api/keys` read remains visible as the row's Checking
  badge, but must not inflate the number of client integrations whose state is
  unknown.

This changes current totals by at most one. That is not a regression hidden by
the layout move; it corrects what the labels already claim to measure. The
“Disable all” button remains file-client-only (`IntegrationsOverview.tsx:293-350`)
and is unaffected.

## i18n

The existing title/count keys stay unchanged. Add one action key to every
locale; hardcoding “Manage keys” in JSX is forbidden by `gui/AGENTS.md`.

| Key | File | Value |
|---|---|---|
| `integrations.action.manageKeys` | `gui/src/i18n/en.ts` | `Manage keys` |
| `integrations.action.manageKeys` | `gui/src/i18n/ko.ts` | `키 관리` |
| `integrations.action.manageKeys` | `gui/src/i18n/ja.ts` | `キーを管理` |
| `integrations.action.manageKeys` | `gui/src/i18n/zh.ts` | `管理密钥` |
| `integrations.action.manageKeys` | `gui/src/i18n/de.ts` | `Schlüssel verwalten` |
| `integrations.action.manageKeys` | `gui/src/i18n/ru.ts` | `Управлять ключами` |

Reused in all six locales: `integrations.tab.keys`,
`integrations.detail.keyCount`, `integrations.detail.keyNone`, and the three
state labels selected by `IntegrationStateBadge`.

## Test plan

MODIFY `gui/tests/integrations-overview-rows.test.ts`:

1. Destructure `{ keysRow, rows }`; assert null count gives a keys `unknown`
   row while client `unknown` count is 4, not 5.
2. Assert zero gives `absent` + `keyNone`, and two gives `current` +
   `{ count: "2" }`. With Codex, Claude, Desktop, Grok, and one file client
   applied, changing key count through null/zero/two leaves `applied === 5`.
3. Update settled lengths from 5 to 4 and unsettled lengths from 11 to 10;
   assert no member of `rows` has id `keys`.
4. Keep every existing Codex/Desktop/file-client mapping case against `rows`.

MODIFY `gui/tests/overview-state-merge.test.ts`: its `row()` helper reads the
`.rows` member. No assertion changes.

MODIFY `gui/tests/integrations-surfaces.test.tsx` with a mounted overview case:

1. `[data-client="keys"]` exists, but
   `.integration-cards [data-client="keys"]` is null.
2. DOM order is `.integration-summary` → keys row → `.integration-cards`.
3. The row renders issued/none/unknown copy from `/api/keys`; an API-key failure
   does not change the client summary's unknown total.
4. Exactly one button exists inside the row, has `tabIndex === 0`, shows the
   localized action, and clicking it navigates to `#integrations/keys`.

## Verification

1. `cd gui && bun test tests/integrations-overview-rows.test.ts tests/overview-state-merge.test.ts tests/integrations-surfaces.test.tsx`
2. `cd gui && bun test tests && bun run lint && bun run lint:i18n && bun run build`
3. `bun run typecheck`, `bun run test`, `bun run privacy:scan`
4. Start the real dashboard and open `http://localhost:10100/#integrations` at
   1280 px and 390 px. Inspect the screenshot and live DOM: one keys row below
   the summary, no keys descendant inside `.integration-cards`, no wide-card
   chrome, and the grid begins with Codex. At 390 px, switch through all six
   locales and confirm the action text wraps when needed rather than clipping.
5. Keyboard-tab to “Manage keys”; observe a visible focus ring, activate with
   Enter and Space, and confirm `#integrations/keys` opens. Repeat with zero
   keys and a failed keys read to observe absent and unknown states.

Step 4 is **C-RENDER-GROUNDING-01**. The change is not verified by typecheck,
DOM assertions, or a produced-but-unread screenshot: it must be OBSERVED
rendered at `localhost:10100`, and any layout defect must be fixed and observed
again.

## Accept criteria

- C8 — API keys render as one full-width row above `.integration-cards`, below
  the aggregate summary, observed rendered at `localhost:10100`.
- The keys row is absent from the card grid and from all client summary totals;
  its own issued/none/unknown state remains visible.
- One native button is the complete keyboard path to the keys tab; no stretched
  card overlay or duplicate tab stop is introduced.
- C9's GUI tests, lint, i18n lint, build, repository typecheck/test, and privacy
  scan pass before WP4 is called done.
