import { z } from "zod";
import log from "electron-log";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { apps } from "@/db/schema";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";
import { readSettings } from "@/main/settings";
import {
  createAndConnectGithubRepo,
  normalizeGitHubRepoName,
} from "@/ipc/handlers/github_handlers";
import {
  type AgentContext,
  type ToolDefinition,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";

const logger = log.scope("connect_github_repo");

const connectGithubRepoSchema = z.object({
  repo_name: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Name for the new GitHub repository. Spaces and invalid chars are normalized to hyphens. Defaults to the app's name.",
    ),
  org: z
    .string()
    .optional()
    .describe(
      "GitHub org to create the repo under. Omit to use the authenticated user's account.",
    ),
  visibility: z
    .enum(["public", "private"])
    .optional()
    .default("public")
    .describe(
      "Repo visibility. Default `public` so the deployed site URL is shareable.",
    ),
  branch: z
    .string()
    .optional()
    .default("main")
    .describe("Default branch name for the new repo."),
});

type ConnectGithubRepoArgs = z.infer<typeof connectGithubRepoSchema>;

const DESCRIPTION = `
Create a new GitHub repository for the current app, wire it as the local git remote, and persist the org/repo on the apps row.

### When to use
- The app has no \`apps.githubRepo\` set yet AND the user (or the mission goal) wants the project shipped to GitHub / Vercel.
- Run this BEFORE \`connect_vercel_project\` or any \`deploy_preview\` to Vercel call.

### Prerequisites
- User must be signed into GitHub in OrianBuilder Settings (settings.githubAccessToken).
- The local app directory must exist (true once \`create_project\` has run).

### Idempotency
- If the app already has a linked repo this tool refuses with a Precondition error so you don't accidentally create a duplicate. Use \`github_pr\` instead in that case.

### After it runs
- \`apps.githubOrg\`, \`apps.githubRepo\`, \`apps.githubBranch\` will be populated, so \`connect_vercel_project\` and \`github_pr autopilot\` will work.
`;

export const connectGithubRepoTool: ToolDefinition<ConnectGithubRepoArgs> = {
  name: "connect_github_repo",
  description: DESCRIPTION,
  inputSchema: connectGithubRepoSchema,
  // Asking is correct: creating a remote repo is one-way (the name reserves
  // the GitHub URL forever). Even in trusted-workspace / full-autopilot we
  // want the first creation per app to surface to the user. The autonomy
  // policy treats `defaultConsent: "ask"` as a per-call confirmation gate.
  defaultConsent: "ask",
  modifiesState: true,

  getConsentPreview: (args) => {
    const name = args.repo_name?.trim() || "(app name)";
    const owner = args.org?.trim() || "your GitHub account";
    return `Create ${args.visibility ?? "public"} GitHub repo "${name}" under ${owner}`;
  },

  buildXml: (args, isComplete) => {
    if (isComplete) return undefined;
    const name = args.repo_name?.trim() || "";
    return `<orianbuilder-connect-github repo="${escapeXmlAttr(name)}" visibility="${escapeXmlAttr(args.visibility ?? "public")}" status="running">Creating GitHub repository...`;
  },

  execute: async (args, ctx: AgentContext) => {
    const settings = readSettings();
    if (!settings.githubAccessToken?.value) {
      throw new OrianBuilderError(
        "Not authenticated with GitHub. Open Settings → Integrations and sign in.",
        OrianBuilderErrorKind.Auth,
      );
    }

    const app = await db.query.apps.findFirst({
      where: eq(apps.id, ctx.appId),
    });
    if (!app) {
      throw new OrianBuilderError(
        `App ${ctx.appId} not found.`,
        OrianBuilderErrorKind.NotFound,
      );
    }

    if (app.githubOrg && app.githubRepo) {
      throw new OrianBuilderError(
        `App is already linked to ${app.githubOrg}/${app.githubRepo}. Use github_pr to push, or disconnect first via the Configure → Publish panel.`,
        OrianBuilderErrorKind.Precondition,
      );
    }

    const desiredName = (args.repo_name?.trim() || app.name || "app").trim();
    const repoName = normalizeGitHubRepoName(desiredName);
    const isPrivate = args.visibility === "private";
    const branch = args.branch?.trim() || "main";

    logger.info(
      `connect_github_repo: app=${ctx.appId} repo=${repoName} visibility=${args.visibility ?? "public"} org=${args.org ?? "(self)"}`,
    );

    let result: { owner: string; repo: string; branch: string };
    try {
      result = await createAndConnectGithubRepo({
        appId: ctx.appId,
        org: args.org?.trim() ?? "",
        repo: repoName,
        branch,
        isPrivate,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.onXmlComplete(
        `<orianbuilder-connect-github repo="${escapeXmlAttr(repoName)}" visibility="${escapeXmlAttr(args.visibility ?? "public")}" status="failed" error="${escapeXmlAttr(message)}">Failed to create repository: ${escapeXmlContent(message)}</orianbuilder-connect-github>`,
      );
      throw new OrianBuilderError(
        `Failed to create GitHub repository: ${message}`,
        OrianBuilderErrorKind.External,
      );
    }

    const repoUrl = `https://github.com/${result.owner}/${result.repo}`;
    const summary =
      `Created ${args.visibility ?? "public"} GitHub repository ${result.owner}/${result.repo} (branch ${result.branch}). ` +
      `Local git remote 'origin' has been pointed at it. ` +
      `Next step: call \`connect_vercel_project\` to set up auto-deploys, or \`github_pr action=autopilot\` to push the first commit.`;

    ctx.onXmlComplete(
      `<orianbuilder-connect-github repo="${escapeXmlAttr(result.repo)}" owner="${escapeXmlAttr(result.owner)}" branch="${escapeXmlAttr(result.branch)}" visibility="${escapeXmlAttr(args.visibility ?? "public")}" url="${escapeXmlAttr(repoUrl)}" status="success">${escapeXmlContent(summary)}</orianbuilder-connect-github>`,
    );

    return `${summary}\n\nRepository URL: ${repoUrl}`;
  },
};
