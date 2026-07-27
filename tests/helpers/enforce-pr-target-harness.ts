/**
 * Runs the `enforce-pr-target.yml` inline script against a fake GitHub client.
 *
 * Four rounds of adversarial audit killed every attempt to pin this script by
 * text. The script is JavaScript, and JavaScript has infinitely many spellings
 * for the same effect: `const upd = github.rest.pulls.update`,
 * `github.rest["pulls"]["update"]`, `github.request("PATCH …")`, a `...spread`
 * that injects `base: "main"`, `Object.assign(pr.base, …)` instead of a dotted
 * assignment, `if (false) { … }` around the whole body. Each one defeats a
 * regex while preserving every string the regex looks for.
 *
 * So stop reading the script and run it. Hand it a recording client, drive it
 * through the scenarios that matter, and assert on the calls that come out. A
 * rewrite can spell itself any way it likes; the observed calls are the same
 * either way.
 */

export type RecordedCall = { method: string; args: unknown };

export type HarnessResult = {
  calls: RecordedCall[];
  logs: string[];
  warnings: string[];
};

export type PullRequestState = {
  number?: number;
  node_id?: string;
  title?: string;
  draft?: boolean;
  base?: { ref: string };
  user?: { login: string };
};

export type Comment = { id: number; user?: { login: string }; body?: string };

export type RunOptions = {
  /** The PR as `pulls.get` will report it — the live, authoritative state. */
  pr: PullRequestState;
  /**
   * What the webhook delivered, if it differs from `pr`.
   *
   * Real events go stale: the PR is retargeted, edited, or drafted between the
   * webhook firing and the job starting. An audit round exploited a harness
   * that made these the same object — `Object.assign(pr, context.payload.pull_request)`
   * silently overwrote the fetched state with the event's, and every scenario
   * still passed because the two were aliases. They are independent here.
   */
  eventPayload?: PullRequestState;
  /**
   * Comments as `listComments` returns them, PAGE BY PAGE. Pass more than one
   * page to prove the script paginates: an audit round replaced `paginate` with
   * a single `listComments` call, which loses a bot comment that has scrolled
   * onto page two — the workflow then posts a duplicate and forgets what it had
   * changed.
   */
  commentPages?: Comment[][];
  /** Shorthand for a single page. */
  comments?: Comment[];
  /** Method names that should reject, to exercise partial-failure paths. */
  failOn?: string[];
};

const DEFAULT_PR: Required<Omit<PullRequestState, "base" | "user">> & {
  base: { ref: string };
  user: { login: string };
} = {
  number: 42,
  node_id: "PR_kwDOnode42",
  title: "Add a thing",
  draft: false,
  base: { ref: "dev" },
  user: { login: "contributor" },
};

/**
 * Extract the inline `script:` body from the workflow and compile it into an
 * async function with the same free variables `actions/github-script` provides.
 *
 * `github-script` wraps the body in an async function and calls it with
 * `github`, `context`, `core`, `exec`, `glob`, `io`, `fetch`, and `require` in
 * scope. Bare `return` in the body is legal there, which is why the script uses
 * it — so the harness has to compile it the same way for the early-return paths
 * to behave.
 */
export function compileScript(script: string): (scope: Record<string, unknown>) => Promise<void> {
  const names = ["github", "context", "core", "exec", "glob", "io", "fetch", "require", "process"];
  const factory = new Function(
    ...names,
    `return (async () => {\n${script}\n})();`,
  ) as (...args: unknown[]) => Promise<void>;
  return scope => factory(...names.map(name => scope[name]));
}

/**
 * A `process` that reports Node, not Bun.
 *
 * `actions/github-script` executes under Node, so any script that branches on
 * the runtime takes the Node path in production. A harness that leaks Bun lets
 * a mutation run one program in the test and another one for real.
 */
function nodeLikeProcess(): Record<string, unknown> {
  return {
    platform: "linux",
    arch: "x64",
    version: "v20.19.0",
    versions: { node: "20.19.0", v8: "11.3.244.8" },
    env: {
      CI: "true",
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "pull_request_target",
      GITHUB_REPOSITORY: "lidge-jun/opencodex",
      RUNNER_OS: "Linux",
    },
    argv: ["/usr/bin/node", "/home/runner/work/_actions/actions/github-script/dist/index.js"],
    cwd: () => "/home/runner/work/opencodex/opencodex",
    exit: () => { throw new Error("the script must not call process.exit"); },
  };
}

export async function runEnforcePrTarget(
  script: string,
  options: RunOptions,
): Promise<HarnessResult> {
  const calls: RecordedCall[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  const failOn = new Set(options.failOn ?? []);

  const pr = {
    ...DEFAULT_PR,
    ...options.pr,
    base: { ...DEFAULT_PR.base, ...(options.pr.base ?? {}) },
    user: { ...DEFAULT_PR.user, ...(options.pr.user ?? {}) },
  };
  // Deep-independent from `pr`, so nothing the script does to one can reach the
  // other by aliasing. Defaults to the same values; pass `eventPayload` to make
  // it genuinely stale.
  const source = options.eventPayload ?? options.pr;
  const eventPr = {
    ...DEFAULT_PR,
    ...source,
    base: { ...DEFAULT_PR.base, ...(source.base ?? {}) },
    user: { ...DEFAULT_PR.user, ...(source.user ?? {}) },
  };
  const pages: Comment[][] = options.commentPages ?? [options.comments ?? []];

  /**
   * Record the call, then either reject or return a plausible payload. Every
   * entry point goes through here — including `github.request` and
   * `github.graphql`, which is how a rewrite that abandons `github.rest.*`
   * entirely still shows up in the recording.
   */
  function record(method: string, args: unknown, data: unknown = {}): unknown {
    calls.push({ method, args });
    if (failOn.has(method)) {
      throw new Error(`simulated failure: ${method}`);
    }
    // Octokit resolves to a response object, never `undefined`. A harness that
    // returned `undefined` let a mutation branch on the result — `const update =
    // await …update(…); if (update) return;` skipped the draft conversion in
    // production while passing every test here.
    return { status: 200, url: `https://api.github.com/${method}`, headers: {}, data };
  }

  const rest = {
    pulls: {
      get: (args: unknown) => Promise.resolve(record("pulls.get", args, pr)),
      update: (args: unknown) => Promise.resolve(record("pulls.update", args, { ...pr })),
    },
    issues: {
      // Honours `page`, so a caller that skips `paginate` sees only page one —
      // exactly what happens against the real API.
      listComments: (args: unknown) => {
        const page = Number((args as { page?: number })?.page ?? 1);
        return Promise.resolve(record("issues.listComments", args, pages[page - 1] ?? []));
      },
      createComment: (args: unknown) => Promise.resolve(record("issues.createComment", args, { id: 99 })),
      updateComment: (args: unknown) => Promise.resolve(record("issues.updateComment", args, { id: 7 })),
    },
  };

  const github = {
    rest,
    graphql: (query: unknown, variables: unknown) =>
      Promise.resolve(record("graphql", { query, variables })),
    request: (route: unknown, params: unknown) =>
      Promise.resolve(record("request", { route, params })),
    /**
     * `github.paginate(fn, params)` — walk every page and concatenate, the way
     * Octokit does. A one-page fake would make dropping pagination invisible.
     */
    paginate: async (fn: (args: unknown) => Promise<{ data: unknown[] }>, params: unknown) => {
      const collected: unknown[] = [];
      for (let page = 1; page <= pages.length; page += 1) {
        const response = await fn({ ...(params as object), page });
        collected.push(...response.data);
      }
      return collected;
    },
  };

  const context = {
    repo: { owner: "lidge-jun", repo: "opencodex" },
    payload: { pull_request: eventPr },
    eventName: "pull_request_target",
    runId: 1234567890,
  };

  const core = {
    info: (message: unknown) => { logs.push(String(message)); },
    warning: (message: unknown) => { warnings.push(String(message)); },
    setFailed: (message: unknown) => { warnings.push(`setFailed: ${String(message)}`); },
    notice: (message: unknown) => { logs.push(String(message)); },
    debug: () => {},
  };

  /**
   * Callable, like the real bindings — `github-script` passes `exec` and
   * `fetch` as functions, and an audit round used `typeof exec === "function"`
   * to detect the harness and return early, passing every test while doing
   * nothing in production. Being callable is the point; calling one still
   * throws, because this workflow has no business running a subprocess.
   */
  const forbidden = (name: string) => new Proxy(
    function forbiddenBinding() { throw new Error(`the script must not use ${name}`); },
    {
      get(target, key) {
        if (key === "name" || key === "length" || key === "prototype") {
          return Reflect.get(target, key);
        }
        throw new Error(`the script must not use ${name}`);
      },
      apply() { throw new Error(`the script must not use ${name}`); },
    },
  );

  await compileScript(script)({
    github,
    context,
    core,
    exec: forbidden("exec"),
    glob: forbidden("glob"),
    io: forbidden("io"),
    fetch: forbidden("fetch"),
    require: forbidden("require"),
    // `github-script` runs under Node. An audit round detected the harness with
    // `if (!process.versions.bun) return;` — a no-op in production, green here.
    // Shadow `process` with something that looks like the Node the workflow
    // actually gets, so a runtime probe cannot tell the two apart.
    process: nodeLikeProcess(),
  });

  return { calls, logs, warnings };
}

/** Just the method names, in order — the usual thing to assert on. */
export function methodsOf(result: HarnessResult): string[] {
  return result.calls.map(call => call.method);
}

/** Every recorded call to one method. */
export function callsTo(result: HarnessResult, method: string): unknown[] {
  return result.calls.filter(call => call.method === method).map(call => call.args);
}
