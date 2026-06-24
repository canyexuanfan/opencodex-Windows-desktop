# 30 - Loop 3 Runtime and Browser Results

Status: planned.

Runtime checks:

```bash
bun run src/cli.ts stop
bun run src/cli.ts ensure
curl -s 'http://localhost:10100/api/codex-auth/active'
```

Raw account API output contains emails. Record only redacted summaries in this file:

```bash
bun -e 'const r=await fetch("http://localhost:10100/api/codex-auth/accounts?refresh=1"); const d=await r.json(); const a=Array.isArray(d.accounts)?d.accounts:[]; console.log(JSON.stringify({status:r.status, accountCount:a.length, mainCount:a.filter(x=>x.isMain).length, poolCount:a.filter(x=>!x.isMain).length, quotaRows:a.map(x=>({role:x.isMain?"main":"pool", hasWeeklyResetAt:typeof x.quota?.weeklyResetAt==="number", hasFiveHourResetAt:typeof x.quota?.fiveHourResetAt==="number", hasMonthly:typeof x.quota?.monthlyPercent==="number", hasMonthlyResetAt:typeof x.quota?.monthlyResetAt==="number"}))}, null, 2));'
```

Browser checks:

```bash
cli-jaw browser start --agent
cli-jaw browser new-tab http://localhost:10100
cli-jaw browser resize 1280 900
cli-jaw browser snapshot --interactive
cli-jaw browser evaluate 'document.querySelector("[data-page=\"codex-auth\"]")?.click()'
cli-jaw browser wait-for-selector '.quota-row' --timeout 10000
cli-jaw browser evaluate 'Array.from(document.querySelectorAll(".quota-row")).map((el, row) => ({ row, cols: Array.from(el.children).map((child, i) => { const r = child.getBoundingClientRect(); return { i, cls: String(child.className), x: Math.round(r.x), w: Math.round(r.width) }; }) }))'
cli-jaw browser resize 375 812
cli-jaw browser wait-for-selector '.quota-row' --timeout 10000
cli-jaw browser evaluate '({ overflow: document.documentElement.scrollWidth - window.innerWidth, rows: Array.from(document.querySelectorAll(".quota-row")).map((el, row) => ({ row, cols: Array.from(el.children).map((child, i) => { const r = child.getBoundingClientRect(); return { i, cls: String(child.className), x: Math.round(r.x), w: Math.round(r.width) }; }) })) })'
```

If no quota-bearing account is present, record the browser alignment probe as blocked by live-data precondition instead of committing screenshots or raw account payloads.

Results: pending.
