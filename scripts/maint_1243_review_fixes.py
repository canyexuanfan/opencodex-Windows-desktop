from pathlib import Path


def edit(path: str, fn):
    p = Path(path)
    text = p.read_text()
    updated = fn(text)
    if updated == text:
        raise SystemExit(f"{path}: no change")
    p.write_text(updated)


def one(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 occurrence, found {count}")
    return text.replace(old, new, 1)


# Preserve the identities of same-generation concurrent requests when one opens
# the circuit, but only for the purpose of accepting a subsequent HTTP success.
def patch_health(text: str) -> str:
    text = one(
        text,
        '''type InternalUpstreamHostHealth = UpstreamHostHealthEntry & {
  generation: number;
  activeLeaseIds: Set<symbol>;
  halfOpenLeaseId?: symbol;
  /** True only when the entry is owned by opt-in circuit admissions. */
  circuitManaged: boolean;
};''',
        '''type InternalUpstreamHostHealth = UpstreamHostHealthEntry & {
  generation: number;
  activeLeaseIds: Set<symbol>;
  halfOpenLeaseId?: symbol;
  /**
   * Leases admitted in the generation that immediately preceded the current
   * cooldown. They are stale for failure settlement, but a real HTTP response
   * from one still proves the origin is reachable and may close this cooldown.
   */
  cooldownSuccessLeaseIds?: Set<symbol>;
  /** True only when the entry is owned by opt-in circuit admissions. */
  circuitManaged: boolean;
};''',
        "health internal state",
    )
    text = one(
        text,
        '''function advanceGeneration(entry: InternalUpstreamHostHealth): void {
  entry.generation = nextGeneration();
  entry.activeLeaseIds.clear();
  delete entry.halfOpenLeaseId;
}''',
        '''function advanceGeneration(entry: InternalUpstreamHostHealth): void {
  entry.generation = nextGeneration();
  entry.activeLeaseIds.clear();
  delete entry.halfOpenLeaseId;
  delete entry.cooldownSuccessLeaseIds;
}''',
        "generation cleanup",
    )
    text = one(
        text,
        '''  if (threshold > 0 && (reopens || entry.consecutiveFailures >= threshold)) {
    entry.cooldownUntil = now + UPSTREAM_HOST_CIRCUIT_COOLDOWN_MS;
    advanceGeneration(entry);
  } else {''',
        '''  if (threshold > 0 && (reopens || entry.consecutiveFailures >= threshold)) {
    entry.cooldownUntil = now + UPSTREAM_HOST_CIRCUIT_COOLDOWN_MS;
    // The failing lease was settled above. Preserve only its still-in-flight
    // same-generation peers as one-shot reachability proofs. advanceGeneration
    // invalidates them for every other mutation and for any later half-open generation.
    const concurrentSuccessLeaseIds = new Set(entry.activeLeaseIds);
    advanceGeneration(entry);
    if (concurrentSuccessLeaseIds.size > 0) {
      entry.cooldownSuccessLeaseIds = concurrentSuccessLeaseIds;
    }
  } else {''',
        "cooldown opening",
    )
    text = one(
        text,
        '''  const entry = matchingEntry(lease);
  if (!entry || lease.key !== key) return false;
  settleLease(entry, lease);
  entry.consecutiveFailures = 0;''',
        '''  if (lease.key !== key) return false;
  let entry = matchingEntry(lease);
  if (!entry) {
    const coolingEntry = hostHealth.get(key);
    if (
      coolingEntry?.cooldownUntil === undefined
      || !coolingEntry.cooldownSuccessLeaseIds?.delete(lease.leaseId)
    ) return false;
    entry = coolingEntry;
  } else {
    settleLease(entry, lease);
  }
  entry.consecutiveFailures = 0;''',
        "concurrent success reset",
    )
    return text


edit("src/codex/upstream-host-health.ts", patch_health)


# A buildRequest failure occurs after Codex auth has potentially claimed a quota
# probe but before any upstream outcome can own that lease. Release it explicitly.
def patch_core(text: str) -> str:
    return one(
        text,
        '''    let request = await adapter.buildRequest(parsed, { headers: selectedForwardHeaders, translatorBudget });
    recordAdapterReasoning(logCtx, request);''',
        '''    let request: Awaited<ReturnType<typeof adapter.buildRequest>>;
    try {
      request = await adapter.buildRequest(parsed, { headers: selectedForwardHeaders, translatorBudget });
    } catch (error) {
      releaseCodexAuthContextProbeLease(authCtx);
      throw error;
    }
    recordAdapterReasoning(logCtx, request);''',
        "pre-send build cleanup",
    )


edit("src/server/responses/core.ts", patch_core)


# Extend state-machine coverage requested by the fresh review.
def patch_health_tests(text: str) -> str:
    text = one(
        text,
        '''  UPSTREAM_HOST_CIRCUIT_COOLDOWN_MS,
  UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD,''',
        '''  UPSTREAM_HOST_CIRCUIT_COOLDOWN_MS,
  UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD,
  UPSTREAM_HOST_FAILURE_WINDOW_MS,
  UPSTREAM_HOST_HEALTH_MAX_ENTRIES,''',
        "health test imports",
    )
    text = one(
        text,
        '''    expect(normalizeUpstreamHostCircuitThreshold(undefined)).toBe(0);
    expect(normalizeUpstreamHostCircuitThreshold(-1)).toBe(0);
    expect(normalizeUpstreamHostCircuitThreshold(1.5)).toBe(0);
    expect(normalizeUpstreamHostCircuitThreshold(3)).toBe(3);
    expect(normalizeUpstreamHostCircuitThreshold(999)).toBe(UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD);''',
        '''    expect(normalizeUpstreamHostCircuitThreshold(undefined)).toBe(0);
    expect(normalizeUpstreamHostCircuitThreshold(-1)).toBe(0);
    expect(normalizeUpstreamHostCircuitThreshold(0)).toBe(0);
    expect(normalizeUpstreamHostCircuitThreshold("3")).toBe(0);
    expect(normalizeUpstreamHostCircuitThreshold(1.5)).toBe(0);
    expect(normalizeUpstreamHostCircuitThreshold(3)).toBe(3);
    expect(normalizeUpstreamHostCircuitThreshold(UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD)).toBe(
      UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD,
    );
    expect(normalizeUpstreamHostCircuitThreshold(999)).toBe(UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD);''',
        "threshold assertions",
    )
    marker = '  test("a stale completion cannot mutate the generation that opened the circuit", () => {'
    regressions = '''  test("a concurrent HTTP response can close the cooldown opened by its peer", () => {
    const key = upstreamHostHealthKey("openai", "https://chatgpt.com");
    const failing = admit(key, 1, 7_500);
    const succeeding = admit(key, 1, 7_500);

    recordUpstreamHostFailure(key, {
      code: "ECONNREFUSED",
      now: 7_501,
      threshold: 1,
      lease: failing,
    });
    expect(getUpstreamHostHealth(key)?.cooldownUntil).toBe(7_501 + UPSTREAM_HOST_CIRCUIT_COOLDOWN_MS);

    expect(resetUpstreamHostHealth(key, succeeding, 7_502)).toBe(true);
    expect(getUpstreamHostHealth(key)).toBeNull();
  });

  test("a stale failure streak expires after the failure window", () => {
    const key = upstreamHostHealthKey("openai", "https://chatgpt.com");
    fail(key, 3, 12_000);
    expect(getUpstreamHostHealth(key)).toMatchObject({ consecutiveFailures: 1 });

    const afterWindow = 12_000 + UPSTREAM_HOST_FAILURE_WINDOW_MS + 1;
    const lease = admit(key, 3, afterWindow);
    expect(lease.halfOpen).toBe(false);
    recordUpstreamHostFailure(key, {
      code: "ECONNREFUSED",
      now: afterWindow,
      threshold: 3,
      lease,
    });
    expect(getUpstreamHostHealth(key)).toMatchObject({ consecutiveFailures: 1 });
  });

  test("the retention cap evicts the stalest unleased origin", () => {
    for (let i = 0; i < UPSTREAM_HOST_HEALTH_MAX_ENTRIES + 8; i += 1) {
      fail(upstreamHostHealthKey("openai", `https://h${i}.example`), 1, 13_000 + i);
    }
    expect(getUpstreamHostHealth(upstreamHostHealthKey("openai", "https://h0.example"))).toBeNull();
    expect(getUpstreamHostHealth(
      upstreamHostHealthKey("openai", `https://h${UPSTREAM_HOST_HEALTH_MAX_ENTRIES + 7}.example`),
    )).not.toBeNull();
  });

  test("retention pressure never evicts an active admission lease", () => {
    const leases: UpstreamHostAdmissionLease[] = [];
    for (let i = 0; i < UPSTREAM_HOST_HEALTH_MAX_ENTRIES + 1; i += 1) {
      leases.push(admit(upstreamHostHealthKey("openai", `https://active-${i}.example`), 1, 14_000 + i));
    }
    expect(releaseUpstreamHostAdmission(leases[0], 15_000)).toBe(true);
    for (const lease of leases.slice(1)) releaseUpstreamHostAdmission(lease, 15_001);
  });

'''
    return one(text, marker, regressions + marker, "health regressions")


edit("tests/upstream-host-circuit.test.ts", patch_health_tests)


# Protect the pre-send cleanup at the handler seam. A fake Codex auth context
# carries a probe id, and the fake passthrough adapter fails before fetch.
def patch_routing_tests(text: str) -> str:
    text = one(
        text,
        'import { handleResponses, handleResponsesCompact } from "../src/server/responses";',
        'import { handleResponses, handleResponsesCompact } from "../src/server/responses";\nimport * as adapterResolveModule from "../src/server/adapter-resolve";',
        "routing test adapter import",
    )
    marker = '  test("an opt-in regular circuit blocks before selecting another pool account", async () => {'
    regression = '''  test("a pre-send build failure releases the Codex probe lease with host circuit disabled", async () => {
    await withPoolEnv("ocx-regular-build-probe-release-", async config => {
      config.upstreamHostCircuitThreshold = 0;
      const probeAuth = {
        kind: "pool" as const,
        accountId: "pool-a",
        writerGeneration: 1,
        generation: 1,
        accessToken: "probe-token",
        chatgptAccountId: "pool_acc_a",
        probeLeaseId: "probe-lease",
        quotaScope: "shared" as const,
      };
      const authSpy = spyOn(authContextModule, "resolveCodexAuthContext").mockResolvedValue(probeAuth);
      const releaseSpy = spyOn(authContextModule, "releaseCodexAuthContextProbeLease");
      const adapterSpy = spyOn(adapterResolveModule, "resolveAdapter").mockReturnValue({
        name: "openai-responses",
        passthrough: true,
        buildRequest: async () => { throw new Error("synthetic build failure"); },
      } as ReturnType<typeof adapterResolveModule.resolveAdapter>);
      try {
        const request = new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello", stream: false }),
        });
        await expect(handleResponses(request, config, { model: "", provider: "" }))
          .rejects.toThrow("synthetic build failure");
        expect(releaseSpy).toHaveBeenCalledWith(probeAuth);
      } finally {
        adapterSpy.mockRestore();
        releaseSpy.mockRestore();
        authSpy.mockRestore();
      }
    });
  });

'''
    return one(text, marker, regression + marker, "pre-send regression")


edit("tests/responses-compaction-routing.test.ts", patch_routing_tests)


# Keep all locale docs aligned with the actual activation gate.
doc_suffixes = {
    "docs-site/src/content/docs/reference/configuration/providers.md": ' Applies only to Codex Pool routing with no pinned account; it is inert for `codexAccountMode: "direct"` and account-qualified selectors.',
    "docs-site/src/content/docs/ja/reference/configuration/providers.md": ' Codex Pool ルーティングでアカウントが固定されていない場合にのみ適用され、`codexAccountMode: "direct"` とアカウント修飾セレクターでは動作しません。',
    "docs-site/src/content/docs/ko/reference/configuration/providers.md": ' Codex Pool 라우팅에서 계정이 고정되지 않은 경우에만 적용되며, `codexAccountMode: "direct"` 및 계정 한정 선택자에서는 동작하지 않습니다.',
    "docs-site/src/content/docs/ru/reference/configuration/providers.md": ' Применяется только к маршрутизации Codex Pool без закреплённого аккаунта; при `codexAccountMode: "direct"` и для селекторов с указанием аккаунта схема не активна.',
    "docs-site/src/content/docs/zh-cn/reference/configuration/providers.md": ' 仅适用于未固定账户的 Codex Pool 路由；在 `codexAccountMode: "direct"` 或使用账户限定选择器时不会启用。',
}

for path, suffix in doc_suffixes.items():
    def patch_doc(text: str, suffix=suffix, path=path) -> str:
        lines = text.splitlines()
        matches = [i for i, line in enumerate(lines) if line.startswith('| `upstreamHostCircuitThreshold?`')]
        if len(matches) != 1:
            raise SystemExit(f"{path}: expected one circuit docs row, found {len(matches)}")
        i = matches[0]
        if not lines[i].endswith(' |'):
            raise SystemExit(f"{path}: malformed circuit docs row")
        lines[i] = lines[i][:-2] + suffix + ' |'
        if path.endswith('/zh-cn/reference/configuration/providers.md'):
            for j, line in enumerate(lines):
                if line.startswith('| `upstreamFailoverThreshold?`'):
                    lines[j] = line.replace('；未确认的失败仍归属账户。', '。')
                    break
        return '\n'.join(lines) + ('\n' if text.endswith('\n') else '')
    edit(path, patch_doc)
