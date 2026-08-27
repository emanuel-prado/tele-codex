export interface PullRequestContext {
  base: string;
  body: string;
  head: string;
  title: string;
}

const CONVENTIONAL_TITLE = /^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([a-z0-9][a-z0-9-]*\))?!?: [a-z0-9].+/;
const ISSUE_BRANCH = /^agent\/(\d+)-[a-z0-9][a-z0-9-]*$/;
const RELEASE_PLEASE_BRANCH = /^release-please--branches--master(?:--|$)/;

export function validatePullRequest(context: PullRequestContext): string[] {
  const errors: string[] = [];

  if (!CONVENTIONAL_TITLE.test(context.title)) {
    errors.push("pull request title must use Conventional Commits");
  }

  if (context.base === "develop") {
    validateDevelopTarget(context, errors);
  } else if (context.base === "master") {
    validateMasterTarget(context, errors);
  } else {
    errors.push("pull requests must target develop or master");
  }

  return errors;
}

function validateDevelopTarget(context: PullRequestContext, errors: string[]): void {
  if (context.head === "master") {
    if (!/^chore\(release\): sync v\d+\.\d+\.\d+ to develop$/.test(context.title)) {
      errors.push("master-to-develop pull requests must be release synchronization PRs");
    }
    return;
  }

  const issue = ISSUE_BRANCH.exec(context.head)?.[1];
  if (!issue) {
    errors.push("develop only accepts agent/<issue>-<slug> or master branches");
    return;
  }

  if (!new RegExp(`(?:^|\\D)#${issue}(?:\\D|$)`).test(context.body)) {
    errors.push(`pull request body must reference owning issue #${issue}`);
  }
}

function validateMasterTarget(context: PullRequestContext, errors: string[]): void {
  if (context.head === "develop" || RELEASE_PLEASE_BRANCH.test(context.head)) {
    return;
  }
  errors.push("master only accepts develop promotions or Release Please branches");
}

function readContext(): PullRequestContext {
  return {
    base: process.env.GITHUB_BASE_REF ?? "",
    body: process.env.PR_BODY ?? "",
    head: process.env.GITHUB_HEAD_REF ?? "",
    title: process.env.PR_TITLE ?? ""
  };
}

if (process.argv[1]?.endsWith("pr-policy.ts")) {
  const errors = validatePullRequest(readContext());
  if (errors.length > 0) {
    console.error(errors.map((error) => `- ${error}`).join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Pull request follows the repository branch and title policy.");
  }
}
