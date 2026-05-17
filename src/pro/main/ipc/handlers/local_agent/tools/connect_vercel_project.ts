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
import { createAndLinkVercelProject } from "@/ipc/handlers/vercel_handlers";
import {
  type AgentContext,
  type ToolDefinition,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";

const logger = log.scope("connect_vercel_project");

const connectVercelProjectSchema = z.object({
  project_name: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Name for the new Vercel project. Defaults to the app's name. Must be unique within the Vercel team.",
    ),
});

type ConnectVercelProjectArgs = z.infer<typeof connectVercelProjectSchema>;

const DESCRIPTION = `
Create a Vercel project for the current app, link it to the app's already-connected GitHub repository, and trigger an initial production deployment.

### When to use
- The app needs to be hosted on Vercel (web app) OR the Electron download landing page needs a public URL.
- Run AFTER \`connect_github_repo\` has populated the apps.githubOrg/githubRepo fields.

### Prerequisites
- User must be signed into Vercel in Settings (settings.vercelAccessToken).
- App MUST already have GitHub repo linked. If not, call \`connect_github_repo\` first.

### Idempotency
- If the app already has a linked Vercel project this tool refuses with a Precondition error. Use \`deploy_preview\` to ship new versions to that project.

### After it runs
- \`apps.vercelProjectId\` / \`vercelProjectName\` / \`vercelTeamId\` will be populated.
- A first production deployment will be triggered automatically; subsequent deployments go through \`deploy_preview\` or auto-deploy on push to the GitHub branch.

### Pairing with downloads
- For Electron / Android download sites: run \`package_native_artifact\` first to populate \`native-download-site/\`, commit, then \`connect_github_repo\` → \`connect_vercel_project\` → \`github_pr autopilot\`. Vercel will host \`native-download-site/\` as the project root.
`;

export const connectVercelProjectTool: ToolDefinition<ConnectVercelProjectArgs> =
  {
    name: "connect_vercel_project",
    description: DESCRIPTION,
    inputSchema: connectVercelProjectSchema,
    // Same reasoning as connect_github_repo: Vercel project creation is a
    // visible side-effect on the user's account and the project name reserves
    // a stable URL. Ask once per call.
    defaultConsent: "ask",
    modifiesState: true,

    getConsentPreview: (args) => {
      const name = args.project_name?.trim() || "(app name)";
      return `Create Vercel project "${name}" and trigger first production deploy`;
    },

    buildXml: (args, isComplete) => {
      if (isComplete) return undefined;
      const name = args.project_name?.trim() || "";
      return `<orianbuilder-connect-vercel project="${escapeXmlAttr(name)}" status="running">Creating Vercel project...`;
    },

    execute: async (args, ctx: AgentContext) => {
      const settings = readSettings();
      if (!settings.vercelAccessToken?.value) {
        throw new OrianBuilderError(
          "Not authenticated with Vercel. Open Settings → Integrations and sign in.",
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

      if (!app.githubOrg || !app.githubRepo) {
        throw new OrianBuilderError(
          "App must be connected to a GitHub repository before creating a Vercel project. Call connect_github_repo first.",
          OrianBuilderErrorKind.Precondition,
        );
      }

      if (app.vercelProjectId) {
        throw new OrianBuilderError(
          `App is already linked to Vercel project "${app.vercelProjectName ?? app.vercelProjectId}". Use deploy_preview to push new versions.`,
          OrianBuilderErrorKind.Precondition,
        );
      }

      const projectName = (
        args.project_name?.trim() ||
        app.name ||
        `app-${ctx.appId}`
      ).trim();

      logger.info(
        `connect_vercel_project: app=${ctx.appId} project=${projectName} repo=${app.githubOrg}/${app.githubRepo}`,
      );

      try {
        await createAndLinkVercelProject({
          name: projectName,
          appId: ctx.appId,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.onXmlComplete(
          `<orianbuilder-connect-vercel project="${escapeXmlAttr(projectName)}" status="failed" error="${escapeXmlAttr(message)}">Failed to create Vercel project: ${escapeXmlContent(message)}</orianbuilder-connect-vercel>`,
        );
        throw new OrianBuilderError(
          `Failed to create Vercel project: ${message}`,
          OrianBuilderErrorKind.External,
        );
      }

      // Re-read the row so we surface the deployment URL the linker stored.
      const updated = await db.query.apps.findFirst({
        where: eq(apps.id, ctx.appId),
      });
      const deploymentUrl = updated?.vercelDeploymentUrl ?? null;
      const projectId = updated?.vercelProjectId ?? "";

      const summary =
        `Created Vercel project "${projectName}" linked to ${app.githubOrg}/${app.githubRepo}. ` +
        (deploymentUrl
          ? `Initial production deployment URL: ${deploymentUrl}. `
          : `First production deployment was triggered; check the Vercel dashboard for status. `) +
        `Subsequent pushes to the GitHub branch will auto-deploy.`;

      ctx.onXmlComplete(
        `<orianbuilder-connect-vercel project="${escapeXmlAttr(projectName)}" project-id="${escapeXmlAttr(projectId)}" repo="${escapeXmlAttr(`${app.githubOrg}/${app.githubRepo}`)}" url="${escapeXmlAttr(deploymentUrl ?? "")}" status="success">${escapeXmlContent(summary)}</orianbuilder-connect-vercel>`,
      );

      return summary;
    },
  };
