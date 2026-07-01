# 260701 — Cyberpunk Website Mockup (P Plan)

## Goal

Add one isolated, polished cyberpunk-style website mockup to the existing
opencodex GUI. The mockup presents opencodex as a provider-routing command
center while leaving the existing operational dashboard behavior unchanged.

This cycle is a single frontend/UIUX PABCD pass:

- P: plan exact UI surface and file map.
- A: audit the plan against real GUI routing, i18n, and CSS constraints.
- B: implement the mockup page.
- C: build and visually verify.
- D: report how to run the GUI dev server.

## Design Read

```yaml
---
name: opencodex-cyberpunk-mockup
colors:
  primary: "#f4f7fb"
  accent: "#00d6ff"
  secondaryAccent: "#ff2f86"
  background: "#08090f"
typography:
  heading: { fontFamily: "system-ui display stack", fontSize: "clamp(2.4rem, 6vw, 5.4rem)" }
  body: { fontFamily: "system-ui", fontSize: "15px" }
---
```

Reading this as: a visual marketing/mockup surface for developers who already
understand Codex and want to see opencodex as a local routing cockpit.

Do:

- Keep the mockup visually distinct from the production dashboard.
- Use concrete opencodex concepts: providers, routed models, Codex picker,
  sidecars, logs, account pool.
- Keep shapes crisp, cockpit-like, and data-rich.
- Use off-black base, electric cyan accent, magenta highlights as secondary
  event color, and restrained animated scanning effects.

Do not:

- Replace the actual dashboard landing route.
- Use emoji, generic purple gradients, decorative blobs, or fake unrelated metrics.
- Add dependencies.
- Touch backend routing, provider logic, auth, logs, or catalog sync.

## Scope

### IN

- A new hash route `#/cyberpunk`.
- One new React page under `gui/src/pages`.
- Sidebar nav entry and i18n labels.
- CSS for the page only, namespaced with `.cyber-*`.
- Static mockup content using realistic opencodex concepts.
- Responsive layout for desktop, 1024px split-screen, tablet, and mobile.
- Build verification and run instructions.

### OUT

- No backend API changes.
- No provider/auth/model/catalog behavior changes.
- No production dashboard page redesign.
- No new npm dependencies.
- No generated image assets in this pass.
- No push.

## File Change Map

### MODIFY `gui/src/App.tsx`

Current:

- `Page` union contains `dashboard | providers | models | subagents | logs | usage | codex-auth`.
- `VALID_PAGES` mirrors that list.
- `NAV` renders sidebar entries.
- `main` conditionally renders each page.

Planned change:

- Import `CyberpunkMockup` from `./pages/CyberpunkMockup`.
- Import one existing icon or add a small `IconSpark`/`IconCircuit` in
  `gui/src/icons.tsx` if no current icon fits.
- Add `"cyberpunk"` to the `Page` union.
- Add `"cyberpunk"` to `VALID_PAGES`.
- Add `{ id: "cyberpunk", tkey: "nav.cyberpunk", Icon: <chosen icon> }` to `NAV`.
- Render `{page === "cyberpunk" && <CyberpunkMockup />}`.
- Make the content wrapper route-aware so only the cyberpunk page can opt out of
  the default 980px dashboard width, for example
  `className={\`main-inner${page === "cyberpunk" ? " main-inner-cyberpunk" : ""}\`}`.

Acceptance:

- Existing hashes continue to route exactly as before.
- Unknown hash still falls back to `dashboard`.
- `#/cyberpunk` renders the mockup.
- Non-cyberpunk pages continue to use the existing `.main-inner` width.

### ADD `gui/src/pages/CyberpunkMockup.tsx`

Static page component, no API calls.

Sections:

- Hero: `opencodex routing grid` headline, concise subtitle, two CTAs styled as
  visual controls rather than functional links.
- Command Strip: model/provider route examples such as `kiro/claude-opus-4.8`,
  `opencode-go/glm-5.2`, `openai/gpt-5.5`.
- Signal Board: compact cards for providers, sidecar vision/search, account pool,
  model picker, request logs.
- Flow Rail: `Codex CLI -> opencodex -> provider adapter -> response bridge`.
- Terminal Preview: simulated log stream with request IDs, model names, usage
  status, and latency.
- Bottom band: concise "local proxy, global routing" close.

Implementation rules:

- Use semantic sections and headings.
- No fake external logos.
- No emoji.
- No network calls.
- Buttons use `button` with `type="button"` unless they become real links.
- Motion limited to CSS transforms/opacity and disabled under
  `prefers-reduced-motion`.

Acceptance:

- Page renders without required backend state.
- Visible text is specific to opencodex.
- No text clipping at 320px, 390px, 768px, 1024px, and 1440px planned widths.

### MODIFY `gui/src/styles.css`

Add a namespaced block near the end:

- `.cyber-page`
- `.cyber-shell`
- `.cyber-hero`
- `.cyber-kicker`
- `.cyber-title`
- `.cyber-subtitle`
- `.cyber-actions`
- `.cyber-command`
- `.cyber-grid`
- `.cyber-card`
- `.cyber-flow`
- `.cyber-terminal`
- `.cyber-scanline`

CSS constraints:

- Use existing global tokens where possible, but override locally with
  `.cyber-page` variables.
- Add a route-scoped `.main-inner-cyberpunk` override that widens only the
  cyberpunk route container to `max-width: min(1180px, 100%)`.
- Keep page content contained inside that route-scoped wrapper; do not widen the
  default `.main-inner` used by dashboard and operational pages.
- Use `.cyber-shell` for internal section spacing and layout, not as the sole
  escape from the default dashboard width.
- Use CSS Grid, not flex percentage math.
- Use `min-height`, not fixed `100vh`.
- Include `@media (max-width: 1024px)`, `@media (max-width: 768px)`, and
  `@media (max-width: 420px)` behavior.
- Include `@media (prefers-reduced-motion: reduce)`.

Acceptance:

- CSS names do not collide with current dashboard classes.
- Existing dashboard pages preserve visual appearance.
- `.main-inner` default width remains unchanged except when the current route
  adds `.main-inner-cyberpunk`.
- No pure `#000000`; background uses off-black.
- Cyberpunk look uses cyan/magenta as accents without purple-gradient default.

### MODIFY `gui/src/i18n/en.ts`

Add:

- `"nav.cyberpunk": "Cyberpunk"`

If visible page copy is kept directly in `CyberpunkMockup.tsx`, no additional
i18n keys are required for this mockup pass.

### MODIFY `gui/src/i18n/ko.ts`

Add:

- `"nav.cyberpunk": "사이버펑크"`

### MODIFY `gui/src/i18n/zh.ts`

Add:

- `"nav.cyberpunk": "赛博朋克"`

Acceptance:

- `TKey` remains compile-safe because all locale files define the same key.

### OPTIONAL MODIFY `gui/src/icons.tsx`

Only if existing icons do not fit:

- Add `IconCircuit` as a simple stroke-only SVG using the local `S()` helper.

Acceptance:

- No icon dependency.
- Icon follows existing Lucide-style stroke conventions.

## Validation Plan

Commands:

```bash
cd /Users/jun/Developer/new/700_projects/opencodex/gui
bun run build
bun run dev -- --host 127.0.0.1
```

Visual verification:

- Open `http://127.0.0.1:<vite-port>/#/cyberpunk`.
- Check desktop around 1440px.
- Check split-screen around 1024px.
- Check tablet around 768px.
- Check mobile around 390px.
- Check narrow around 320px if available.
- Confirm reduced-motion path does not rely on animation to convey information.

Acceptance criteria:

- `bun run build` passes.
- Existing dashboard routes still compile.
- New mockup route is reachable from sidebar and direct hash.
- Page has no clipped button/card text in planned viewport checks.
- No backend dependency is required to render the mockup.
- Final report includes dev server command and URL.

## Risks

- The existing `.main-inner` max-width is 980px, which can make a cyberpunk
  landing-style page feel too cramped. Mitigation: add only a route-scoped
  `.main-inner-cyberpunk` wrapper class for `#/cyberpunk`; keep the default
  `.main-inner` width unchanged for dashboard and operational pages.
- Existing dashboard palette is intentionally restrained; the mockup must be
  isolated with `.cyber-*` classes to avoid changing production pages.
- i18n compile safety means nav key must be added to all locale files.
