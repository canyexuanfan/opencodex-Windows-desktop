import { describe, expect, test } from "bun:test";

type Workflow = {
  on?: {
    issue_comment?: { types?: string[] };
  };
  jobs?: Record<
    string,
    {
      if?: string;
      steps?: Array<{
        name?: string;
        with?: Record<string, string>;
      }>;
    }
  >;
};

describe("CodeRabbit readiness revalidation", () => {
  test("CodeRabbit PR status comments can rerun the findings gate", async () => {
    const text = await Bun.file(
      new URL("../.github/workflows/enforce-pr-target.yml", import.meta.url),
    ).text();
    const workflow = Bun.YAML.parse(text) as Workflow;

    expect(workflow.on?.issue_comment?.types).toEqual(["created", "edited"]);

    const job = workflow.jobs?.["enforce-target"];
    expect(job).toBeDefined();
    expect(job?.if).toContain("github.event.issue.pull_request != null");
    expect(job?.if).toContain("github.event.comment.user.login == 'coderabbitai[bot]'");

    const checkoutStep = job?.steps?.find(
      step => step.name === "Checkout trusted PR-quality scripts",
    );
    expect(checkoutStep?.with?.ref).toBe(
      "${{ github.event_name == 'issue_comment' && github.event.repository.default_branch || github.event.pull_request.base.sha }}",
    );

    const gateStep = job?.steps?.find(
      step => step.name === "Enforce PR target, ancestry, and description",
    );
    const script = gateStep?.with?.script ?? "";

    expect(script).toContain('const CODE_RABBIT_LOGIN = "coderabbitai[bot]"');
    expect(script).toContain("const isCodeRabbit = commenter === CODE_RABBIT_LOGIN");
    expect(script).toContain("!isCodeRabbit");
    expect(script).toContain("isCanonicalMaintainer");
    expect(script).toMatch(
      /!isPrComment\s*\|\|\s*\(\s*!isCodeRabbit\s*&&\s*\(\s*!\[[\s\S]{0,300}?\.includes\(association\)\s*\|\|\s*!isCanonicalMaintainer\s*\)\s*\)/,
    );
    expect(script).toContain("unresolvedFindingsClaim");
  });
});
