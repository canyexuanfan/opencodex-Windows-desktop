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

export type RunOptions = {
  /** The PR as `pulls.get` will report it. */
  pr: PullRequestState;
  /** Existing issue comments, in the order `listComments` returns them. */
  comments?: { id: number; user?: { login: string }; body?: string }[];
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
  const names = ["github", "context", "core", "exec", "glob", "io", "fetch", "require"];
  const factory = new Function(
    ...names,
    `return (async () => {\n${script}\n})();`,
  ) as (...args: unknown[]) => Promise<void>;
  return scope => factory(...names.map(name => scope[name]));
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
  const comments = options.comments ?? [];

  /**
   * Record the call, then either reject or return a plausible payload. Every
   * entry point goes through here — including `github.request` and
   * `github.graphql`, which is how a rewrite that abandons `github.rest.*`
   * entirely still shows up in the recording.
   */
  function record(method: string, args: unknown): unknown {
    calls.push({ method, args });
    if (failOn.has(method)) {
      throw new Error(`simulated failure: ${method}`);
    }
    return undefined;
  }

  const rest = {
    pulls: {
      get: (args: unknown) => {
        record("pulls.get", args);
        return Promise.resolve({ data: pr });
      },
      update: (args: unknown) => Promise.resolve(record("pulls.update", args)),
    },
    issues: {
      listComments: (args: unknown) => {
        record("issues.listComments", args);
        return Promise.resolve({ data: comments });
      },
      createComment: (args: unknown) => Promise.resolve(record("issues.createComment", args)),
      updateComment: (args: unknown) => Promise.resolve(record("issues.updateComment", args)),
    },
  };

  const github = {
    rest,
    graphql: (query: unknown, variables: unknown) =>
      Promise.resolve(record("graphql", { query, variables })),
    request: (route: unknown, params: unknown) =>
      Promise.resolve(record("request", { route, params })),
    /**
     * `github.paginate(fn, params)` — call the underlying method and hand back
     * the array, matching Octokit's contract closely enough for this script.
     */
    paginate: async (fn: (args: unknown) => Promise<{ data: unknown[] }>, params: unknown) => {
      const response = await fn(params);
      return response.data;
    },
  };

  const context = {
    repo: { owner: "lidge-jun", repo: "opencodex" },
    payload: { pull_request: { ...pr } },
  };

  const core = {
    info: (message: unknown) => { logs.push(String(message)); },
    warning: (message: unknown) => { warnings.push(String(message)); },
    setFailed: (message: unknown) => { warnings.push(`setFailed: ${String(message)}`); },
    notice: (message: unknown) => { logs.push(String(message)); },
    debug: () => {},
  };

  const forbidden = (name: string) => new Proxy({}, {
    get() { throw new Error(`the script must not use ${name}`); },
    apply() { throw new Error(`the script must not use ${name}`); },
  });

  await compileScript(script)({
    github,
    context,
    core,
    exec: forbidden("exec"),
    glob: forbidden("glob"),
    io: forbidden("io"),
    fetch: forbidden("fetch"),
    require: forbidden("require"),
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
