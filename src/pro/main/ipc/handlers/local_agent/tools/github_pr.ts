import { z } from "zod";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { apps } from "@/db/schema";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";
import { readSettings } from "@/main/settings";
import { getOrianBuilderAppPath } from "@/paths/paths";
import {
  gitAddAll,
  gitCheckout,
  gitCommit,
  gitCreateBranch,
  gitCurrentBranch,
  gitListBranches,
  gitPush,
  gitSetRemoteUrl,
  isGitStatusClean,
} from "@/ipc/utils/git_utils";
import {
  createGithubPullRequest,
  getGithubPullRequestStatus,
  getLatestGithubWorkflowRuns,
  listGithubPullRequestComments,
  listGithubPullRequests,
} from "@/ipc/utils/github_pr_api";

import {
  type AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
  type ToolDefinition,
} from "./types";

const githubPrSchema = z.object({
  action: z
    .enum([
      "ensure_branch",
      "commit_all",
      "push",
      "open_pr",
      "list_prs",
      "pr_status",
      "pr_comments",
      "list_workflow_runs",
      "autopilot",
    ])
    .describe(
      "Operation to perform. `autopilot` runs ensure_branch → commit_all → push → open_pr in one shot.",
    ),
  branch: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe(
      "Target branch name. Defaults to a generated `agent/<slug>` branch for autopilot.",
    ),
  base: z
    .string()
    .optional()
    .describe(
      "Base branch for `open_pr`/`autopilot`. Defaults to the app's tracked GitHub branch (usually `main`).",
    ),
  title: z
    .string()
    .max(180)
    .optional()
    .describe("Pull request title. Required for `open_pr`/`autopilot`."),
  body: z
    .string()
    .max(6000)
    .optional()
    .describe(
      "Pull request body in markdown. Optional for `open_pr`/`autopilot`.",
    ),
  commit_message: z
    .string()
    .max(500)
    .optional()
    .describe("Commit message. Required for `commit_all`/`autopilot`."),
  pull_number: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Pull request number for `pr_status`/`pr_comments`."),
  draft: z
    .boolean()
    .optional()
    .describe("If true, open the PR as a draft. Defaults to false."),
  force_with_lease: z
    .boolean()
    .optional()
    .describe(
      "If true, push with `--force-with-lease`. Use only when the agent rewrote history (e.g. after squash).",
    ),
  state: z
    .enum(["open", "closed", "all"])
    .optional()
    .describe("State filter for `list_prs`. Defaults to `open`."),
  workflow_branch: z
    .string()
    .optional()
    .describe(
      "Branch filter for `list_workflow_runs`. Defaults to the current branch.",
    ),
});

type GithubPrArgs = z.infer<typeof githubPrSchema>;

interface ResolvedRepoContext {
  appId: number;
  appPath: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  accessToken: string;
}

async function resolveRepoContext(
  ctx: AgentContext,
): Promise<ResolvedRepoContext> {
  const settings = readSettings();
  const accessToken = settings.githubAccessToken?.value;
  if (!accessToken) {
    throw new OrianBuilderError(
      "GitHub is not connected. Ask the user to authorize GitHub from Settings before retrying.",
      OrianBuilderErrorKind.Auth,
    );
  }
  const app = await db.query.apps.findFirst({ where: eq(apps.id, ctx.appId) });
  if (!app) {
    throw new OrianBuilderError(
      `App ${ctx.appId} not found while resolving GitHub repo context.`,
      OrianBuilderErrorKind.NotFound,
    );
  }
  if (!app.githubOrg || !app.githubRepo) {
    throw new OrianBuilderError(
      "This app is not connected to a GitHub repository. Connect it from the app settings before using github_pr.",
      OrianBuilderErrorKind.Precondition,
    );
  }
  return {
    appId: app.id,
    appPath: getOrianBuilderAppPath(app.path),
    owner: app.githubOrg,
    repo: app.githubRepo,
    defaultBranch: app.githubBranch ?? "main",
    accessToken,
  };
}

function slugifyBranch(input: string) {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "task";
}

async function ensureRemoteUrl(repo: ResolvedRepoContext) {
  const remoteUrl = `https://${repo.accessToken}:x-oauth-basic@github.com/${repo.owner}/${repo.repo}.git`;
  await gitSetRemoteUrl({ path: repo.appPath, remoteUrl });
}

async function performEnsureBranch(
  repo: ResolvedRepoContext,
  branchName: string,
): Promise<{ branch: string; created: boolean }> {
  const localBranches = await gitListBranches({ path: repo.appPath });
  const current = await gitCurrentBranch({ path: repo.appPath });
  if (current === branchName) {
    return { branch: branchName, created: false };
  }
  if (localBranches.includes(branchName)) {
    await gitCheckout({ path: repo.appPath, ref: branchName });
    return { branch: branchName, created: false };
  }
  await gitCreateBranch({ path: repo.appPath, branch: branchName });
  await gitCheckout({ path: repo.appPath, ref: branchName });
  return { branch: branchName, created: true };
}

async function performCommitAll(
  repo: ResolvedRepoContext,
  commitMessage: string,
): Promise<{ commitHash: string | null }> {
  const isClean = await isGitStatusClean({ path: repo.appPath });
  if (isClean) {
    return { commitHash: null };
  }
  await gitAddAll({ path: repo.appPath });
  const hash = await gitCommit({ path: repo.appPath, message: commitMessage });
  return { commitHash: hash };
}

async function performPush(
  repo: ResolvedRepoContext,
  branch: string,
  forceWithLease: boolean,
) {
  await ensureRemoteUrl(repo);
  await gitPush({
    path: repo.appPath,
    branch,
    accessToken: repo.accessToken,
    forceWithLease,
  });
}

function buildPrBody(
  args: GithubPrArgs,
  context: { branch: string; appId: number },
) {
  const fallback = [
    `Generated by OrianBuilder agent for app #${context.appId}.`,
    `Source branch: ${context.branch}`,
  ].join("\n");
  return args.body && args.body.trim().length > 0 ? args.body : fallback;
}

export const githubPrTool: ToolDefinition<GithubPrArgs> = {
  name: "github_pr",
  description: `Drive the GitHub pull request lifecycle for the current app.

Supported actions:
- ensure_branch: create or check out the target branch.
- commit_all: stage and commit every change with the supplied message (no-op if clean).
- push: push the current branch to origin with the user's token.
- open_pr: open a pull request from the current branch into the app's default branch.
- list_prs: list pull requests on the linked repo.
- pr_status: fetch state, mergeability, combined status, and check runs for a PR.
- pr_comments: list review and issue comments on a PR.
- list_workflow_runs: list recent GitHub Actions runs for the branch.
- autopilot: end-to-end ensure_branch → commit_all → push → open_pr.

Requires the app to be connected to GitHub (org/repo present) and a valid access token in settings. The tool only operates on the app's own working tree.`,
  inputSchema: githubPrSchema,
  defaultConsent: "ask",
  modifiesState: true,

  getConsentPreview: (args) => {
    switch (args.action) {
      case "ensure_branch":
        return `Create/checkout branch ${args.branch ?? "(auto)"}`;
      case "commit_all":
        return `Stage and commit all changes: "${args.commit_message ?? ""}"`;
      case "push":
        return `Push branch ${args.branch ?? "(current)"} to origin`;
      case "open_pr":
        return `Open PR "${args.title ?? ""}" from ${args.branch ?? "(current)"} -> ${args.base ?? "(default)"}`;
      case "autopilot":
        return `Autopilot PR: commit "${args.commit_message ?? ""}" then open "${args.title ?? ""}"`;
      default:
        return `GitHub PR action: ${args.action}`;
    }
  },

  buildXml: (args, isComplete) => {
    if (!args.action || isComplete) return undefined;
    return `<orianbuilder-github-pr action="${escapeXmlAttr(args.action)}">`;
  },

  execute: async (args, ctx: AgentContext) => {
    const repo = await resolveRepoContext(ctx);
    const baseBranch = args.base ?? repo.defaultBranch;

    switch (args.action) {
      case "ensure_branch": {
        const branchName =
          args.branch ?? `agent/${slugifyBranch(`mission-${Date.now()}`)}`;
        const result = await performEnsureBranch(repo, branchName);
        const summary = `Branch ${result.branch} ${result.created ? "created" : "checked out"}.`;
        ctx.onXmlComplete(
          `<orianbuilder-github-pr action="ensure_branch" branch="${escapeXmlAttr(result.branch)}" created="${result.created}">${escapeXmlContent(summary)}</orianbuilder-github-pr>`,
        );
        return summary;
      }
      case "commit_all": {
        if (!args.commit_message) {
          throw new OrianBuilderError(
            "commit_all requires a commit_message.",
            OrianBuilderErrorKind.Validation,
          );
        }
        const result = await performCommitAll(repo, args.commit_message);
        const summary = result.commitHash
          ? `Committed all changes as ${result.commitHash}.`
          : "Working tree clean; nothing to commit.";
        ctx.onXmlComplete(
          `<orianbuilder-github-pr action="commit_all" commit-hash="${escapeXmlAttr(result.commitHash ?? "")}">${escapeXmlContent(summary)}</orianbuilder-github-pr>`,
        );
        return summary;
      }
      case "push": {
        const branch =
          args.branch ?? (await gitCurrentBranch({ path: repo.appPath }));
        if (!branch) {
          throw new OrianBuilderError(
            "Could not determine the current branch to push.",
            OrianBuilderErrorKind.Precondition,
          );
        }
        await performPush(repo, branch, args.force_with_lease === true);
        const summary = `Pushed ${branch} to origin (force-with-lease=${args.force_with_lease === true}).`;
        ctx.onXmlComplete(
          `<orianbuilder-github-pr action="push" branch="${escapeXmlAttr(branch)}">${escapeXmlContent(summary)}</orianbuilder-github-pr>`,
        );
        return summary;
      }
      case "open_pr": {
        if (!args.title) {
          throw new OrianBuilderError(
            "open_pr requires a title.",
            OrianBuilderErrorKind.Validation,
          );
        }
        const head =
          args.branch ?? (await gitCurrentBranch({ path: repo.appPath }));
        if (!head) {
          throw new OrianBuilderError(
            "Could not determine the head branch for the pull request.",
            OrianBuilderErrorKind.Precondition,
          );
        }
        const pr = await createGithubPullRequest({
          owner: repo.owner,
          repo: repo.repo,
          accessToken: repo.accessToken,
          head,
          base: baseBranch,
          title: args.title,
          body: buildPrBody(args, { branch: head, appId: repo.appId }),
          draft: args.draft,
        });
        const summary = `Opened PR #${pr.number} (${pr.state}): ${pr.url}`;
        ctx.onXmlComplete(
          `<orianbuilder-github-pr action="open_pr" pr-number="${pr.number}" pr-url="${escapeXmlAttr(pr.url)}" head="${escapeXmlAttr(head)}" base="${escapeXmlAttr(baseBranch)}">${escapeXmlContent(summary)}</orianbuilder-github-pr>`,
        );
        return summary;
      }
      case "list_prs": {
        const prs = await listGithubPullRequests({
          owner: repo.owner,
          repo: repo.repo,
          accessToken: repo.accessToken,
          state: args.state ?? "open",
        });
        const summary = prs
          .slice(0, 20)
          .map(
            (pr) =>
              `#${pr.number} [${pr.state}] ${pr.title} (${pr.headRef} -> ${pr.baseRef}) ${pr.url}`,
          )
          .join("\n");
        const text = summary || "No pull requests matched the filter.";
        ctx.onXmlComplete(
          `<orianbuilder-github-pr action="list_prs" count="${prs.length}">${escapeXmlContent(text)}</orianbuilder-github-pr>`,
        );
        return text;
      }
      case "pr_status": {
        if (!args.pull_number) {
          throw new OrianBuilderError(
            "pr_status requires pull_number.",
            OrianBuilderErrorKind.Validation,
          );
        }
        const status = await getGithubPullRequestStatus({
          owner: repo.owner,
          repo: repo.repo,
          accessToken: repo.accessToken,
          pullNumber: args.pull_number,
        });
        const checkSummary = status.checkRuns
          .slice(0, 10)
          .map(
            (run) =>
              `${run.name}: ${run.status}${run.conclusion ? ` (${run.conclusion})` : ""}`,
          )
          .join("\n");
        const summary = [
          `PR #${status.number} state=${status.state} merged=${status.merged}`,
          `mergeable=${status.mergeable === null ? "unknown" : status.mergeable} (${status.mergeableState ?? "n/a"})`,
          `combined_status=${status.combinedStatusState ?? "n/a"}`,
          `head=${status.headRef} (${status.headSha.slice(0, 7)})`,
          checkSummary || "No check runs reported.",
          status.url,
        ].join("\n");
        ctx.onXmlComplete(
          `<orianbuilder-github-pr action="pr_status" pr-number="${status.number}" state="${escapeXmlAttr(status.state)}" merged="${status.merged}">${escapeXmlContent(summary)}</orianbuilder-github-pr>`,
        );
        return summary;
      }
      case "pr_comments": {
        if (!args.pull_number) {
          throw new OrianBuilderError(
            "pr_comments requires pull_number.",
            OrianBuilderErrorKind.Validation,
          );
        }
        const comments = await listGithubPullRequestComments({
          owner: repo.owner,
          repo: repo.repo,
          accessToken: repo.accessToken,
          pullNumber: args.pull_number,
        });
        const text = comments.length
          ? comments
              .slice(0, 25)
              .map((c) => {
                const location =
                  c.path && c.line
                    ? ` ${c.path}:${c.line}`
                    : c.path
                      ? ` ${c.path}`
                      : "";
                return `[${c.kind}] ${c.author}${location} (${c.createdAt}): ${c.body.slice(0, 600)}`;
              })
              .join("\n---\n")
          : "No comments on this pull request.";
        ctx.onXmlComplete(
          `<orianbuilder-github-pr action="pr_comments" pr-number="${args.pull_number}" count="${comments.length}">${escapeXmlContent(text)}</orianbuilder-github-pr>`,
        );
        return text;
      }
      case "list_workflow_runs": {
        const branch =
          args.workflow_branch ??
          (await gitCurrentBranch({ path: repo.appPath })) ??
          undefined;
        const runs = await getLatestGithubWorkflowRuns({
          owner: repo.owner,
          repo: repo.repo,
          accessToken: repo.accessToken,
          branch: branch ?? undefined,
        });
        const text = runs.length
          ? runs
              .map(
                (run) =>
                  `${run.name} [${run.status}${run.conclusion ? `/${run.conclusion}` : ""}] ${run.headBranch} (${run.headSha.slice(0, 7)}) ${run.htmlUrl}`,
              )
              .join("\n")
          : "No recent workflow runs.";
        ctx.onXmlComplete(
          `<orianbuilder-github-pr action="list_workflow_runs" branch="${escapeXmlAttr(branch ?? "")}" count="${runs.length}">${escapeXmlContent(text)}</orianbuilder-github-pr>`,
        );
        return text;
      }
      case "autopilot": {
        if (!args.commit_message) {
          throw new OrianBuilderError(
            "autopilot requires commit_message.",
            OrianBuilderErrorKind.Validation,
          );
        }
        if (!args.title) {
          throw new OrianBuilderError(
            "autopilot requires title.",
            OrianBuilderErrorKind.Validation,
          );
        }
        const branchName =
          args.branch ??
          `agent/${slugifyBranch(args.title)}-${Date.now().toString(36)}`;
        const ensure = await performEnsureBranch(repo, branchName);
        const commit = await performCommitAll(repo, args.commit_message);
        await performPush(repo, ensure.branch, args.force_with_lease === true);
        const pr = await createGithubPullRequest({
          owner: repo.owner,
          repo: repo.repo,
          accessToken: repo.accessToken,
          head: ensure.branch,
          base: baseBranch,
          title: args.title,
          body: buildPrBody(args, { branch: ensure.branch, appId: repo.appId }),
          draft: args.draft,
        });
        const summary = [
          `Branch ${ensure.branch} ${ensure.created ? "created" : "reused"}`,
          commit.commitHash
            ? `Committed all changes (${commit.commitHash}).`
            : "No staged changes; nothing committed.",
          `Pushed to origin.`,
          `Opened PR #${pr.number}: ${pr.url}`,
        ].join("\n");
        ctx.onXmlComplete(
          `<orianbuilder-github-pr action="autopilot" pr-number="${pr.number}" pr-url="${escapeXmlAttr(pr.url)}" branch="${escapeXmlAttr(ensure.branch)}" base="${escapeXmlAttr(baseBranch)}" commit-hash="${escapeXmlAttr(commit.commitHash ?? "")}">${escapeXmlContent(summary)}</orianbuilder-github-pr>`,
        );
        return summary;
      }
      default: {
        const exhaustiveCheck: never = args.action;
        throw new OrianBuilderError(
          `Unsupported github_pr action: ${String(exhaustiveCheck)}`,
          OrianBuilderErrorKind.Validation,
        );
      }
    }
  },
};
