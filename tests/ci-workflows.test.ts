import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const doctorGuiIfChangedScript = fileURLToPath(new URL("../scripts/doctor-gui-if-changed.ts", import.meta.url));

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

function count(text: string, fragment: string): number {
  return text.split(fragment).length - 1;
}

describe("GitHub Actions hardening", () => {
  test("cross-platform CI keeps bounded jobs and immutable action references", async () => {
    const workflow = await readText(".github/workflows/ci.yml");

    expect(count(workflow, "timeout-minutes: 12")).toBe(1);
    expect(count(workflow, "timeout-minutes: 8")).toBe(1);
    expect(workflow).toContain("actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0");
    expect(workflow).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6");
    expect(workflow).toContain("actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e");
    expect(workflow).toContain("bun test --isolate tests");
    expect(workflow).not.toMatch(/uses:\s+\S+@(?:v\d+|main|master)\b/);
  });

  test("cross-platform CI keeps the GUI lint and build gates", async () => {
    // Review finding (PR #97): the GUI build gate was silently dropped once; assert the
    // enhanced gate (PR #99) stays wired so broken GUI builds cannot merge unnoticed.
    const workflow = await readText(".github/workflows/ci.yml");

    expect(workflow).toContain("- name: GUI lint");
    expect(workflow).toContain("bun run lint");
    expect(workflow).toContain("- name: GUI build");
    expect(workflow).toContain("bun run build");
  });

  test("service lifecycle is least-privilege, bounded, and cannot swallow health failures", async () => {
    const workflow = await readText(".github/workflows/service-lifecycle.yml");

    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("group: service-lifecycle-${{ github.ref }}");
    expect(workflow).toContain("cancel-in-progress: true");
    expect(count(workflow, "timeout-minutes: 10")).toBe(3);
    expect(count(workflow, "if: ${{ !cancelled() }}")).toBe(3);
    expect(workflow).not.toContain("always()");
    expect(workflow).not.toContain('healthz || echo "healthz not ready yet"');
    expect(workflow).not.toContain("sleep 8");
    expect(workflow).toContain("systemd service has no positive MainPID before crash test");
    expect(workflow).toContain("Get-ScheduledTask -TaskName opencodex-proxy -ErrorAction SilentlyContinue");
    expect(workflow).toContain("launchd artifact or proxy survived uninstall");
    expect(workflow).toContain("scheduled task or proxy survived uninstall");
    expect(workflow).not.toMatch(/uses:\s+\S+@(?:v\d+|main|master)\b/);
  });

  test("release workflow gates the exact SHA, channel, and service surface without injection", async () => {
    const workflow = await readText(".github/workflows/release.yml");

    // Least privilege + never cancel a publish mid-flight.
    expect(workflow).toContain("actions: read");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("timeout-minutes: 15");

    // Dry-run first by default; tokenless trusted publishing only.
    expect(workflow).toMatch(/dry-run:[\s\S]*?default: true/);
    expect(workflow).not.toContain("secrets.NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN:");

    // Immutable action references.
    expect(workflow).toContain("actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0");
    expect(workflow).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6");
    expect(workflow).toContain("actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e");
    expect(workflow).not.toMatch(/uses:\s+\S+@(?:v\d+|main|master)\b/);

    // Workflow-dispatch inputs must reach shell code via env, never by direct
    // interpolation into run: source (script-injection hardening).
    const runBlocks = workflow.split(/\n {6,}- name: /).filter(block => block.includes("run: |"));
    for (const block of runBlocks) {
      const runSource = block.slice(block.indexOf("run: |"));
      expect(runSource).not.toContain("${{ inputs.");
    }

    // The service gate must cover the post-restructure service surface and stay
    // in sync with every service-lifecycle.yml push trigger path.
    const gateMatch = workflow.match(/grep -Eq '(\^\([^']+\)\$)'/);
    expect(gateMatch).not.toBeNull();
    const gate = new RegExp(gateMatch![1]!);
    const lifecycle = await readText(".github/workflows/service-lifecycle.yml");
    const pushPaths = lifecycle
      .split("push:")[1]!
      .split("workflow_dispatch:")[0]!
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.startsWith('- "'))
      .map(line => line.slice(3, -1));
    expect(pushPaths.length).toBeGreaterThanOrEqual(6);
    for (const path of pushPaths) {
      expect(gate.test(path)).toBe(true);
    }
    expect(gate.test("src/cli/index.ts")).toBe(true);
    expect(gate.test("src/lib/bun-runtime.ts")).toBe(true);
    expect(gate.test("src/cli.ts")).toBe(true);

    // PR and push triggers must stay path-set identical, and both must cover the
    // pre-restructure compat stub src/cli.ts that the release gate regex checks
    // (devlog 260716_passthrough_followups/020 — a release whose only service change
    // is src/cli.ts must auto-trigger service-lifecycle instead of dead-ending the gate).
    const prPaths = lifecycle
      .split("pull_request:")[1]!
      .split("push:")[0]!
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.startsWith('- "'))
      .map(line => line.slice(3, -1));
    expect([...prPaths].sort()).toEqual([...pushPaths].sort());
    expect(prPaths).toContain("src/cli.ts");
    expect(pushPaths).toContain("src/cli.ts");
    expect(gate.test("src/router.ts")).toBe(false);
    expect(gate.test("docs-site/src/pages/index.astro")).toBe(false);

    // Channel guards stay branch-exact.
    expect(workflow).toContain("Release must run from main or preview");
    expect(workflow).toContain("main releases must use a stable semver version");
    expect(workflow).toContain("preview releases must use a preview prerelease version");

    // Release notes must include PR categories and the full channel commit range
    // (branch merges + direct commits). Preflight forbids an existing release, so
    // only create (not edit) is wired. Stable releases also carry matching preview notes.
    expect(workflow).toContain("releases/generate-notes");
    expect(workflow).toContain("git log --pretty=format:'- %s (%h)'");
    expect(workflow).toContain('commit_range="${notes_range_start}..${GITHUB_SHA}"');
    expect(workflow).toContain('previous_tag_name=${notes_range_start}');
    expect(workflow).toContain("skipping generate-notes (commits-only notes)");
    expect(workflow).toContain("bun scripts/release-notes.ts strip-carried");
    expect(workflow).toContain("bun scripts/release-notes.ts assemble");
    expect(workflow).toContain("bun scripts/release-notes.ts matching-preview-tags");
    expect(workflow).toContain("bun scripts/release-notes.ts has-meaningful");
    expect(workflow).toContain("bun scripts/release-notes.ts join-carried");
    expect(workflow).toContain("releases/tags/");
    expect(workflow).toContain('gh api "repos/${GITHUB_REPOSITORY}" --jq \'.full_name\'');
    expect(workflow).toContain("git merge-base --is-ancestor");
    expect(workflow).toContain("operational error, not a missing release");
    expect(workflow).toContain("not an ancestor");
    expect(workflow).toContain("newest_carried_preview_tag");
    expect(workflow).not.toMatch(/newest_preview_tag="\$preview_carry_tag"/);
    expect(workflow).toContain("--commits");
    expect(workflow).toContain('git tag --list "v${RELEASE_VERSION}-preview.*"');
    expect(workflow).toContain("Carrying preview release notes from");
    // Every subcommand the workflow invokes must be dispatched by the CLI.
    const releaseNotesHelper = await readText("scripts/release-notes.ts");
    const invoked = [...workflow.matchAll(/bun scripts\/release-notes\.ts ([a-z-]+)/g)]
      .map(m => m[1]!);
    expect(invoked.length).toBeGreaterThan(0);
    for (const cmd of new Set(invoked)) {
      expect(releaseNotesHelper).toContain(`"${cmd}"`);
    }
    expect(workflow).toMatch(/gh release create[\s\S]*?--notes-file "\$notes_file"/);
    expect(workflow).not.toContain("gh release edit");
    expect(workflow).not.toContain("--generate-notes");
    // Notes must be assembled before tagging so a notes API failure does not leave
    // a remote tag that blocks release retries at preflight.
    const createStep = workflow.split("- name: Create GitHub release")[1]!.split(/\n {6}- name:/)[0]!;
    // Preview carry lookup must use tag-specific API status, not `gh release view` stderr prose.
    expect(createStep).toContain("releases/tags/");
    expect(createStep).not.toContain("gh release view");
    // Fail closed: no soft-skip in any spelling around gh api calls in this step.
    for (const line of createStep.split("\n").filter(l => l.includes("gh api"))) {
      expect(line).not.toMatch(/\|\|\s*(true|echo|:)/);
    }
    expect(createStep).not.toContain("set +e\n            pr_notes");
    expect(createStep.indexOf("gh api")).toBeGreaterThan(-1);
    expect(createStep.indexOf('git tag "$release_tag"')).toBeGreaterThan(-1);
    expect(createStep.indexOf("gh api")).toBeLessThan(createStep.indexOf('git tag "$release_tag"'));
    // First-channel releases must not call generate-notes without an explicit baseline
    // (GitHub would otherwise pick the newest repo tag, possibly from the other channel).
    // Scope to the single if-block that owns generate-notes; createStep has two
    // `[ -n "$notes_range_start" ]` blocks, so an unanchored [\s\S]* can straddle them.
    const notesBlock = createStep
      .split(/if \[ -n "\$notes_range_start" \]; then/)[1]!
      .split(/\n {10}if \[/)[0]!;
    expect(notesBlock).toContain("previous_tag_name=${notes_range_start}");
    expect(notesBlock).toContain("skipping generate-notes");
    expect(notesBlock).toMatch(/\n {10}else\n/);
  });

  /**
   * `enforce-pr-target.yml` had no test at all, and it is the one workflow that
   * mutates a contributor's pull request — it rewrites the title and converts the
   * PR to a draft. It also runs on `pull_request_target`, so it holds the base
   * repository's write token while doing it.
   *
   * These assertions pin the CURRENT behaviour rather than a desired one. The
   * gate is being redesigned (devlog/_plan/260727_governance_intake/040), and a
   * redesign without a characterisation test is how the four review rounds on
   * that plan happened in the first place.
   *
   * They parse the workflow rather than grepping it. Two rounds of adversarial
   * mutation testing broke the string-matching version: `- run : echo pwn` and
   * `- 'uses': owner/action@feature` are valid YAML that no reasonable regex
   * catches, and `// await convertToDraft();` satisfies a substring check while
   * removing the behaviour. A parser sees keys, not spellings.
   */
  type WorkflowStep = { name?: string; uses?: string; run?: string; with?: { script?: string } };
  type WorkflowShape = {
    on?: { pull_request_target?: { types?: string[] } };
    permissions?: Record<string, string> | string;
    concurrency?: { group?: string };
    jobs?: Record<string, { steps?: WorkflowStep[] }>;
  };

  async function readEnforcePrTarget(): Promise<{
    workflow: WorkflowShape;
    steps: WorkflowStep[];
    script: string;
  }> {
    const text = await readText(".github/workflows/enforce-pr-target.yml");
    const workflow = Bun.YAML.parse(text) as WorkflowShape;
    const steps = workflow.jobs?.["enforce-target"]?.steps;
    expect(Array.isArray(steps)).toBe(true);
    const scriptStep = steps!.find(step => typeof step.with?.script === "string");
    expect(scriptStep).toBeDefined();
    const script = stripLineComments(String(scriptStep!.with!.script));
    return { workflow, steps: steps!, script };
  }

  /**
   * Drop `//` line comments so a commented-out call cannot satisfy a "calls X"
   * assertion — but only where `//` really starts a comment. The script builds a
   * message containing `https://…`, and a naive `line.replace(/\/\/.*$/, "")`
   * truncates that string literal, quietly weakening everything after it. Track
   * quoting instead.
   */
  function stripLineComments(source: string): string {
    return source
      .split("\n")
      .map(line => {
        let quote: string | null = null;
        for (let i = 0; i < line.length; i += 1) {
          const char = line[i]!;
          if (char === "\\") { i += 1; continue; }
          if (quote) {
            if (char === quote) quote = null;
            continue;
          }
          if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
          if (char === "/" && line[i + 1] === "/") return line.slice(0, i);
        }
        return line;
      })
      .join("\n");
  }

  test("PR target enforcement stays least-privilege and never runs PR code", async () => {
    const { workflow, steps } = await readEnforcePrTarget();

    // pull_request_target runs with the base repo's token. Checking out or
    // executing the PR's code under it is the classic escalation.
    expect(Object.keys(workflow.on ?? {})).toEqual(["pull_request_target"]);

    // Exactly one permission scope. Asserting that `pull-requests: write` is
    // present says nothing about what was added beside it, and a `write-all`
    // scalar is not an object at all.
    expect(workflow.permissions).toEqual({ "pull-requests": "write" });

    // No step may run a shell command, and every action must be pinned to a
    // 40-hex commit SHA — this workflow hands a write token to whatever it
    // resolves to, so a tag or branch ref is a mutable dependency.
    for (const step of steps) {
      expect(step).not.toHaveProperty("run");
      const uses = step.uses;
      expect(typeof uses).toBe("string");
      expect(String(uses)).not.toContain("actions/checkout");
      expect(String(uses)).toMatch(/@[0-9a-f]{40}$/);
    }
    expect(steps.some(step => String(step.uses).startsWith("actions/github-script@"))).toBe(true);

    // One run per PR, so two rapid events cannot race on the title/draft state.
    expect(workflow.concurrency?.group).toBe(
      "enforce-pr-target-${{ github.event.pull_request.number }}",
    );
  });

  test("PR target enforcement reacts to the events that can change the verdict", async () => {
    const { workflow, script } = await readEnforcePrTarget();

    // `edited` is what catches a retarget; `ready_for_review` is what re-applies
    // the draft when someone undoes it by hand. Dropping either silently makes
    // the gate one-shot.
    const types = workflow.on?.pull_request_target?.types ?? [];
    expect([...types].sort()).toEqual(["edited", "opened", "ready_for_review", "reopened"]);

    // The verdict is a live base-branch comparison, not a cached one: re-read the
    // PR, then derive wrongBase from it. Pinning the comparison itself stops a
    // rewrite that leaves the constant in place while hard-coding the answer.
    expect(script).toContain("github.rest.pulls.get");
    expect(script).toMatch(/const EXPECTED_BASE = "dev";/);
    expect(script).toMatch(/const wrongBase = pr\.base\.ref !== EXPECTED_BASE;/);
  });

  test("PR target enforcement records what it changed so it can undo it", async () => {
    const { script } = await readEnforcePrTarget();

    // The bot rewrites the author's title and draft state, so it stores which of
    // those it touched and restores exactly those on a correct retarget. Losing
    // this bookkeeping means a PR that was already a draft gets marked ready, or
    // that the `[WRONG BRANCH] ` prefix is never removed.
    expect(script).toMatch(/state\.autoDraftedByBot\s*=\s*true/);
    expect(script).toMatch(/state\.titlePrefixedByBot\s*=\s*true/);
    expect(script).toMatch(/storedState\.autoDraftedByBot/);
    expect(script).toMatch(/storedState\.titlePrefixedByBot/);
    expect(script).toMatch(/await\s+convertToDraft\(\)/);
    expect(script).toMatch(/await\s+markReadyForReview\(\)/);

    // Tie each helper to its GraphQL body. Asserting that the call and the
    // mutation name both appear somewhere leaves a gap: declaring an empty
    // `async function convertToDraft() {}` later in the script shadows the real
    // one, removes the behaviour, and satisfies both checks. Require exactly one
    // declaration of each, and require it to contain the mutation.
    for (const [helper, mutation] of [
      ["convertToDraft", "convertPullRequestToDraft"],
      ["markReadyForReview", "markPullRequestReadyForReview"],
    ] as const) {
      const declarations = [...script.matchAll(new RegExp(`function\\s+${helper}\\s*\\(`, "g"))];
      expect(declarations).toHaveLength(1);
      const body = script.slice(declarations[0]!.index!);
      const nextDeclaration = body.slice(1).search(/\n\s*(?:async\s+)?function\s/);
      expect(nextDeclaration === -1 ? body : body.slice(0, nextDeclaration + 1)).toContain(mutation);
    }
    expect(script).toMatch(/const TITLE_PREFIX = "\[WRONG BRANCH\] ";/);

    // Observed on PR #527 (devlog .../050_live_evidence.md): the state is written
    // BEFORE the mutation and is not reconciled when the mutation fails, so a
    // failed convertToDraft still records autoDraftedByBot: true. This documents
    // that ordering rather than endorsing it — the redesign in 040 owns fixing
    // it, and this assertion should change with it.
    //
    // Scope the comparison to the wrong-base branch: upsertComment is called from
    // both branches, so comparing across the whole script would measure whichever
    // call happens to come first in the text.
    const branchStart = script.indexOf("if (wrongBase) {");
    expect(branchStart).toBeGreaterThan(-1);
    const branch = script.slice(branchStart);
    const stateWriteIndex = branch.indexOf("await upsertComment(");
    const draftCallIndex = branch.indexOf("await convertToDraft()");
    expect(stateWriteIndex).toBeGreaterThan(-1);
    expect(draftCallIndex).toBeGreaterThan(stateWriteIndex);
  });


  test("docs deployment is pinned, bounded, and scoped to Pages", async () => {
    const workflow = await readText(".github/workflows/deploy-docs.yml");

    expect(workflow).toContain("permissions:\n  contents: read\n  pages: write\n  id-token: write");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("timeout-minutes: 15");
    expect(workflow).toContain("timeout-minutes: 10");
    expect(workflow).toContain("actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0");
    expect(workflow).toContain("withastro/action@e84f40bd8d2caa9e768ec82ad30dd81f0b280853");
    expect(workflow).toContain("actions/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128");
    expect(workflow).not.toMatch(/uses:\s+\S+@(?:v\d+|main|master)\b/);
  });

  test("issue-quality workflow rejects workflow_dispatch pull request numbers before mutation", async () => {
    const workflow = await readText(".github/workflows/enforce-issue-quality.yml");

    expect(workflow).toContain("issue_comment:");
    expect(workflow).toContain("Translate non-English issue comments");
    expect(workflow).toContain("shouldTranslateComment");
    expect(workflow).toContain("buildTranslatedCommentBody");
    expect(workflow).toContain("github.rest.issues.updateComment");
    expect(workflow).toContain("group: issue-translation-${{ github.event.issue.number }}");
    expect(workflow).not.toContain("issue-comment-translation-${{ github.event.comment.id }}");
    expect(workflow).toContain("if: github.event_name == 'issue_comment'");
    expect(workflow).toMatch(
      /translate:\s*\n\s*name: Translate non-English issues\s*\n\s*if: github\.event_name == 'issues' \|\| github\.event_name == 'workflow_dispatch'/,
    );
    expect(workflow).toMatch(
      /validate:\s*\n\s*if: github\.event_name == 'issues' \|\| github\.event_name == 'workflow_dispatch'/,
    );

    const commentJob = workflow.split(/\n {2}translate-comment:\n/)[1]!.split(/\n {2}[a-zA-Z]/)[0]!;
    expect(commentJob).toContain("parse-issue-translation-response.cjs");
    expect(commentJob).toContain("Apply inline comment translation");
    expect(commentJob).toContain("isPreparedSourceStillCurrent");
    expect(commentJob).toContain("updateComment");
    expect(commentJob).toContain("requires_translation == 'true'");
    expect(commentJob).toContain("group: issue-translation-${{ github.event.issue.number }}");
    expect(commentJob).toContain("# Required to rewrite the triggering issue comment in place.");
    expect(commentJob).toContain("sourceKey:");
    // Same fail-closed parse → apply gate as the issue path.
    const commentParse = commentJob
      .split("- name: Parse AI response")[1]!
      .split("- name: Apply inline comment translation")[0]!;
    expect(commentParse).toContain("parse-issue-translation-response.cjs");
    const commentRun = commentParse.split(/\n\s*run:\s*/)[1];
    expect(commentRun).toBeDefined();
    expect(commentRun!).not.toContain("${{");
    const commentApply = commentJob
      .split("- name: Apply inline comment translation")[1]!
      .split("- name: Persist comment translation control state")[0]!;
    const guardAt = commentApply.indexOf("isPreparedSourceStillCurrent({");
    const updateAt = commentApply.indexOf("updateComment");
    const missingAt = commentApply.indexOf("missingRequiredTranslationFields({");
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(updateAt).toBeGreaterThanOrEqual(0);
    expect(missingAt).toBeGreaterThanOrEqual(0);
    expect(missingAt).toBeLessThan(updateAt);
    expect(guardAt).toBeLessThan(updateAt);
    expect(commentApply).toContain("omitted required field(s)");

    // Job-scoped permissions only (no top-level issues:write; no actions:write).
    expect(workflow).toMatch(
      /jobs:\s*\n\s*translate:[\s\S]*?permissions:\s*\n(?:\s*#.*\n)*\s*contents: read\s*\n(?:\s*#.*\n)*\s*issues: write\s*\n(?:\s*#.*\n)*\s*models: read/,
    );
    const translateJob = workflow.split(/\n {2}translate:\n/)[1]!.split(/\n {2}[a-zA-Z]/)[0]!;
    expect(translateJob).not.toMatch(/actions:\s*write/);
    expect(workflow).toMatch(
      /jobs:\s*\n\s*translate:[\s\S]*?validate:[\s\S]*?permissions:\s*\n\s*contents: read\s*\n\s*#.*\n\s*issues: write/,
    );
    const beforeJobs = workflow.split(/jobs:\s*\n/)[0]!;
    expect(beforeJobs).not.toMatch(/^\s*permissions:/m);

    // Non-cancelling per-issue concurrency at workflow and translate-job scope.
    expect(workflow).toContain("group: issue-quality-${{ github.event.issue.number || inputs.issue_number }}");
    expect(workflow).toContain("group: issue-translation-${{ github.event.issue.number || inputs.issue_number }}");
    const workflowConcurrency = workflow.split(/jobs:\s*\n/)[0]!;
    expect(workflowConcurrency).toMatch(
      /concurrency:\s*\n\s*group: issue-quality-[^\n]*\n\s*cancel-in-progress:\s*false/,
    );
    expect(translateJob).toMatch(
      /concurrency:\s*\n\s*group: issue-translation-[^\n]*\n\s*cancel-in-progress:\s*false/,
    );
    expect(translateJob).toContain("translation-state-degraded");
    expect(translateJob).toContain("core.summary");

    // Trusted scripts always come from the repository default branch.
    const checkoutStep = workflow
      .split("- name: Checkout trusted workflow code")[1]!
      .split(/\n {6}- name:/)[0]!;
    expect(checkoutStep).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(checkoutStep).toContain("persist-credentials: false");
    expect(checkoutStep).toContain("sparse-checkout: .github/scripts");

    const script = workflow
      .split("- name: Validate issue quality")[1]!
      .split("script: |")[1]!
      .split(/\n {6}- name:/)[0]!;

    // Invalid issue numbers fail before any issues API call.
    const invalidNumberIdx = script.indexOf("Invalid workflow_dispatch issue_number:");
    const firstIssuesGetIdx = script.indexOf("github.rest.issues.get({");
    expect(invalidNumberIdx).toBeGreaterThan(-1);
    expect(firstIssuesGetIdx).toBeGreaterThan(-1);
    expect(invalidNumberIdx).toBeLessThan(firstIssuesGetIdx);

    // Non-default-branch dispatches fail before any issues API mutation.
    const branchGuardIdx = script.indexOf("const nonDefaultBranchFailure = rejectsWorkflowDispatchNonDefaultBranch(");
    const firstMutationIdx = script.indexOf("github.rest.issues.update({");
    expect(branchGuardIdx).toBeGreaterThan(-1);
    expect(firstMutationIdx).toBeGreaterThan(-1);
    expect(branchGuardIdx).toBeLessThan(firstMutationIdx);
    expect(branchGuardIdx).toBeLessThan(firstIssuesGetIdx);

    // Pull-request numbers are rejected after issues.get and before mutations.
    const prGuardIdx = script.indexOf("const pullRequestFailure = rejectsWorkflowDispatchPullRequest(");
    const listCommentsIdx = script.indexOf("github.rest.issues.listComments");
    const addLabelsIdx = script.indexOf("github.rest.issues.addLabels");
    expect(prGuardIdx).toBeGreaterThan(-1);
    expect(prGuardIdx).toBeGreaterThan(firstIssuesGetIdx);
    expect(prGuardIdx).toBeLessThan(listCommentsIdx);
    expect(prGuardIdx).toBeLessThan(addLabelsIdx);
    expect(prGuardIdx).toBeLessThan(firstMutationIdx);
    expect(script).toContain("if (pullRequestFailure) {");
    expect(script).toContain("core.setFailed(pullRequestFailure);");

    const translateScript = workflow
      .split("- name: Prepare translation")[1]!
      .split("- name: Detect and translate")[0]!;
    const branchGuardIdxTranslate = translateScript.indexOf(
      "rejectsWorkflowDispatchNonDefaultBranch(",
    );
    const issuesGetIdxTranslate = translateScript.indexOf("github.rest.issues.get({");
    expect(branchGuardIdxTranslate).toBeGreaterThan(-1);
    expect(issuesGetIdxTranslate).toBeGreaterThan(-1);
    expect(branchGuardIdxTranslate).toBeLessThan(issuesGetIdxTranslate);
    expect(translateScript).toContain("resolveControlState");
    expect(translateScript).toContain("Never trust author-editable issue body markers");

    const applyScript = workflow
      .split("- name: Apply inline translation")[1]!
      .split("- name: Persist translation control state")[0]!;
    const staleGuardIdx = applyScript.indexOf("isPreparedSourceStillCurrent({");
    const issueUpdateIdx = applyScript.indexOf("github.rest.issues.update(");
    expect(staleGuardIdx).toBeGreaterThan(-1);
    expect(issueUpdateIdx).toBeGreaterThan(-1);
    expect(staleGuardIdx).toBeLessThan(issueUpdateIdx);
    expect(applyScript).toContain("persistTranslationControlState");
    expect(applyScript).toContain("Translation control state not persisted");
    expect(applyScript).toContain("sourceComplete");
    expect(applyScript).toContain("source remains retryable");
    expect(applyScript).toContain("missingRequiredTranslationFields");
    expect(applyScript).toContain("omitted required field(s)");
    expect(applyScript).toMatch(/sourceComplete,\s*\n\s*\}/);
    expect(applyScript.indexOf("missingRequiredTranslationFields({")).toBeLessThan(
      applyScript.indexOf("github.rest.issues.update("),
    );

    const parseStep = workflow
      .split("- name: Parse AI response")[1]!
      .split("- name: Apply inline translation")[0]!;
    expect(parseStep).toContain("parse-issue-translation-response.cjs");
    expect(parseStep).not.toContain("node -e");
    expect(parseStep).not.toContain("node <<");
    // AI output must stay in env, never interpolated into the shell run script.
    expect(parseStep.split(/\n\s*run:\s*/)[1] || "").not.toContain("${{");

    const persistStep = workflow
      .split("- name: Persist translation control state")[1]!
      .split(/\n {2}[a-zA-Z]/)[0]!;
    expect(persistStep).toContain("always()");
    expect(persistStep).toContain("requires_translation != 'true'");
    expect(persistStep).toContain("persistTranslationControlState");
    expect(persistStep).toContain("SOURCE_COMPLETE");
    expect(persistStep).toContain("detectedLanguageForControlPersist");
    expect(persistStep).toContain('const sourceComplete = process.env.SOURCE_COMPLETE === "true"');
    expect(persistStep).toMatch(/sourceComplete,\s*\n\s*\}/);
    // Missing DETECTED_LANG on incomplete/skipped parse must not default to English.
    expect(persistStep).not.toContain('DETECTED_LANG || "English"');
    expect(persistStep).not.toContain("DETECTED_LANG || 'English'");
    expect(persistStep).not.toContain("silent_state");
    expect(persistStep).not.toContain("cleanup_comment_ids");
    expect(workflow).not.toContain("Save translation control state cache");
    expect(workflow).not.toContain("Remove migrated English control comments");
    expect(workflow).not.toContain("Restore translation control state cache");

    const commentPersist = workflow
      .split("- name: Persist comment translation control state")[1]!
      .split(/\n {2}[a-zA-Z]/)[0]!;
    expect(commentPersist).toContain('const sourceComplete = process.env.SOURCE_COMPLETE === "true"');
    expect(commentPersist).toContain("detectedLanguageForControlPersist");
    expect(commentPersist).toMatch(/sourceComplete,\s*\n\s*\}/);
    expect(commentPersist).not.toContain('DETECTED_LANG || "English"');
    expect(commentPersist).not.toContain("DETECTED_LANG || 'English'");
    const commentApplyStep = workflow
      .split("- name: Apply inline comment translation")[1]!
      .split("- name: Persist comment translation control state")[0]!;
    expect(commentApplyStep).toContain("sourceComplete");
    expect(commentApplyStep).toContain("source remains retryable");
    expect(commentApplyStep).toContain("missingRequiredTranslationFields");
    expect(commentApplyStep).toContain("omitted required field(s)");
    const commentMissingAt = commentApplyStep.indexOf("missingRequiredTranslationFields({");
    const commentUpdateAt = commentApplyStep.indexOf("updateComment");
    expect(commentMissingAt).toBeGreaterThanOrEqual(0);
    expect(commentUpdateAt).toBeGreaterThanOrEqual(0);
    expect(commentMissingAt).toBeLessThan(commentUpdateAt);

    // Helper contract: always-visible bookkeeping; sticky oldest upsert; body non-authoritative.
    const helperSrc = await readText(".github/scripts/issue-translation.cjs");
    expect(helperSrc).toContain("shouldOmitVisibleBookkeeping");
    expect(helperSrc).toContain("findStickyControlComment");
    expect(helperSrc).toContain("detectedLanguageForControlPersist");
    expect(helperSrc).toContain("Automated translation bookkeeping");
    expect(helperSrc).toContain("canonical comment first");
    expect(helperSrc).toContain("Authoritative control state comes only from verified bot-owned comments");
    expect(helperSrc).toContain("sourceComplete");
    expect(helperSrc).not.toContain("writeFileControlState");
    expect(helperSrc).not.toContain(".ocx-translation-state");
  });

  test("React Doctor workflow is SHA-pinned, engine-pinned, advisory, and read-only", async () => {
    const workflow = await readText(".github/workflows/react-doctor.yml");

    expect(workflow).toContain("actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8");
    expect(workflow).toContain("millionco/react-doctor@938008119a288f2fb47c66a69cd9279a21f31784");
    expect(workflow).not.toMatch(/uses:\s+\S+@(?:v\d+|main|master)\b/);

    // Engine pin: the action wrapper would fetch react-doctor@latest without it.
    expect(workflow).toContain('version: "0.9.1"');

    // Action pin must accept CLI JSON schemaVersion 3 (baseline reports from 0.9.1).
    // v2.1.0's ensure-json-report only knew schemas 1–2 and failed every PR scan.
    // Advisory + least privilege: read-only token, all write-scoped outputs off.
    // pull-requests: read is required so the action can list PR files for
    // --changed-files-from; without it, fork PRs fail with ENOENT on that file.
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("pull-requests: read");
    expect(workflow).not.toContain(": write");
    expect(workflow).toContain("blocking: none");
    expect(workflow).toContain("comment: false");
    expect(workflow).toContain("review-comments: false");
    expect(workflow).toContain("commit-status: false");
    expect(workflow).toContain("timeout-minutes: 10");
  });

  test("React Doctor package scripts pin the exact engine version with no @latest anywhere", async () => {
    const guiPkg = await readText("gui/package.json");
    const rootPkg = await readText("package.json");

    expect(guiPkg).toContain("react-doctor@0.9.1");
    expect(guiPkg).not.toContain("react-doctor@latest");
    expect(rootPkg).not.toContain("react-doctor@latest");
    expect(rootPkg).toContain('"doctor:gui:if-changed": "bun scripts/doctor-gui-if-changed.ts"');
    expect(rootPkg).toContain('"lint:gui": "cd gui && bun run lint"');
    // Gating steps (typecheck, eslint, tests, privacy) run before advisory React Doctor.
    expect(rootPkg).toContain("bun run typecheck && bun run lint:gui && bun run test");
    expect(rootPkg).toContain("bun run privacy:scan && bun run doctor:gui:if-changed");
  });
});

describe("doctor-gui-if-changed", () => {
  test("guiPathsChanged is a slash-guarded gui/ prefix predicate", async () => {
    const { guiPathsChanged } = await import("../scripts/doctor-gui-if-changed");

    expect(guiPathsChanged(["gui/src/App.tsx"])).toBe(true);
    expect(guiPathsChanged(["gui"])).toBe(true);
    expect(guiPathsChanged(["scripts/foo.ts", "gui/package.json"])).toBe(true);
    expect(guiPathsChanged(["scripts/foo.ts"])).toBe(false);
    expect(guiPathsChanged(["guitools/x.ts"])).toBe(false);
    expect(guiPathsChanged([])).toBe(false);
  });

  test("DRY_RUN prints the run/skip decision without spawning the doctor", () => {
    const run = Bun.spawnSync(["bun", doctorGuiIfChangedScript], {
      env: { ...process.env, DOCTOR_DRY_RUN: "1", DOCTOR_FILES: "gui/src/App.tsx\nscripts/x.ts" },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain("doctor:run");

    const skip = Bun.spawnSync(["bun", doctorGuiIfChangedScript], {
      env: { ...process.env, DOCTOR_DRY_RUN: "1", DOCTOR_FILES: "scripts/x.ts\nREADME.md" },
    });
    expect(skip.exitCode).toBe(0);
    expect(skip.stdout.toString()).toContain("doctor:skip");
  });

  test("degrades gracefully when the doctor engine is unavailable (offline prepush)", () => {
    const run = Bun.spawnSync(["bun", doctorGuiIfChangedScript], {
      env: {
        ...process.env,
        DOCTOR_FILES: "gui/src/App.tsx",
        DOCTOR_CMD: "definitely-not-a-real-command-xyz",
      },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stderr.toString()).toContain("skipping advisory scan");
  });
});
