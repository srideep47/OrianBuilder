import fetch from "node-fetch";

import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";
import { IS_TEST_BUILD } from "@/ipc/utils/test_utils";

export const GITHUB_API_BASE = IS_TEST_BUILD
  ? `http://localhost:${process.env.FAKE_LLM_PORT || "3500"}/github/api`
  : "https://api.github.com";

export interface GitHubRepoIdentity {
  owner: string;
  repo: string;
  accessToken: string;
}

interface GitHubErrorPayload {
  message?: string;
  documentation_url?: string;
  errors?: unknown;
}

async function readJson<T>(response: Awaited<ReturnType<typeof fetch>>) {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function buildError(
  response: Awaited<ReturnType<typeof fetch>>,
  payload: GitHubErrorPayload | null,
) {
  const message =
    payload?.message ||
    `${response.status} ${response.statusText || "GitHub error"}`;
  return new OrianBuilderError(
    `GitHub API error: ${message}`,
    response.status === 401 || response.status === 403
      ? OrianBuilderErrorKind.Auth
      : OrianBuilderErrorKind.External,
  );
}

function authHeaders(accessToken: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function createGithubPullRequest(
  input: GitHubRepoIdentity & {
    head: string;
    base: string;
    title: string;
    body: string;
    draft?: boolean;
    maintainerCanModify?: boolean;
  },
): Promise<{
  number: number;
  url: string;
  state: string;
  headRef: string;
  baseRef: string;
  isDraft: boolean;
}> {
  const url = `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}/pulls`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...authHeaders(input.accessToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      head: input.head,
      base: input.base,
      title: input.title,
      body: input.body,
      draft: input.draft ?? false,
      maintainer_can_modify: input.maintainerCanModify ?? true,
    }),
  });
  if (!response.ok) {
    const payload = await readJson<GitHubErrorPayload>(response);
    throw buildError(response, payload);
  }
  const data = (await response.json()) as {
    number: number;
    html_url: string;
    state: string;
    head: { ref: string };
    base: { ref: string };
    draft?: boolean;
  };
  return {
    number: data.number,
    url: data.html_url,
    state: data.state,
    headRef: data.head.ref,
    baseRef: data.base.ref,
    isDraft: data.draft === true,
  };
}

export async function listGithubPullRequests(
  input: GitHubRepoIdentity & {
    state?: "open" | "closed" | "all";
    head?: string;
    base?: string;
  },
): Promise<
  Array<{
    number: number;
    title: string;
    state: string;
    url: string;
    headRef: string;
    baseRef: string;
    isDraft: boolean;
  }>
> {
  const params = new URLSearchParams({
    state: input.state ?? "open",
    per_page: "30",
  });
  if (input.head) params.set("head", input.head);
  if (input.base) params.set("base", input.base);
  const url = `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}/pulls?${params.toString()}`;
  const response = await fetch(url, {
    headers: authHeaders(input.accessToken),
  });
  if (!response.ok) {
    const payload = await readJson<GitHubErrorPayload>(response);
    throw buildError(response, payload);
  }
  const data = (await response.json()) as Array<{
    number: number;
    title: string;
    state: string;
    html_url: string;
    head: { ref: string };
    base: { ref: string };
    draft?: boolean;
  }>;
  return data.map((pr) => ({
    number: pr.number,
    title: pr.title,
    state: pr.state,
    url: pr.html_url,
    headRef: pr.head.ref,
    baseRef: pr.base.ref,
    isDraft: pr.draft === true,
  }));
}

export async function getGithubPullRequestStatus(
  input: GitHubRepoIdentity & {
    pullNumber: number;
  },
): Promise<{
  number: number;
  state: string;
  merged: boolean;
  mergeable: boolean | null;
  mergeableState: string | null;
  headSha: string;
  headRef: string;
  baseRef: string;
  url: string;
  combinedStatusState: string | null;
  checkRuns: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    url: string;
  }>;
}> {
  const baseUrl = `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}`;
  const prResponse = await fetch(`${baseUrl}/pulls/${input.pullNumber}`, {
    headers: authHeaders(input.accessToken),
  });
  if (!prResponse.ok) {
    const payload = await readJson<GitHubErrorPayload>(prResponse);
    throw buildError(prResponse, payload);
  }
  const pr = (await prResponse.json()) as {
    number: number;
    state: string;
    merged: boolean;
    mergeable: boolean | null;
    mergeable_state: string | null;
    head: { sha: string; ref: string };
    base: { ref: string };
    html_url: string;
  };

  const [combinedRes, checkRunsRes] = await Promise.all([
    fetch(`${baseUrl}/commits/${pr.head.sha}/status`, {
      headers: authHeaders(input.accessToken),
    }),
    fetch(`${baseUrl}/commits/${pr.head.sha}/check-runs?per_page=50`, {
      headers: authHeaders(input.accessToken),
    }),
  ]);

  let combinedStatusState: string | null = null;
  if (combinedRes.ok) {
    const combined = (await combinedRes.json()) as { state: string };
    combinedStatusState = combined.state ?? null;
  }

  let checkRuns: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    url: string;
  }> = [];
  if (checkRunsRes.ok) {
    const data = (await checkRunsRes.json()) as {
      check_runs?: Array<{
        name: string;
        status: string;
        conclusion: string | null;
        html_url: string;
      }>;
    };
    checkRuns = (data.check_runs ?? []).map((run) => ({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      url: run.html_url,
    }));
  }

  return {
    number: pr.number,
    state: pr.state,
    merged: pr.merged,
    mergeable: pr.mergeable,
    mergeableState: pr.mergeable_state,
    headSha: pr.head.sha,
    headRef: pr.head.ref,
    baseRef: pr.base.ref,
    url: pr.html_url,
    combinedStatusState,
    checkRuns,
  };
}

export async function listGithubPullRequestComments(
  input: GitHubRepoIdentity & {
    pullNumber: number;
  },
): Promise<
  Array<{
    id: number;
    author: string;
    body: string;
    path: string | null;
    line: number | null;
    createdAt: string;
    htmlUrl: string;
    kind: "review" | "issue";
  }>
> {
  const baseUrl = `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}`;
  const [reviewRes, issueRes] = await Promise.all([
    fetch(`${baseUrl}/pulls/${input.pullNumber}/comments?per_page=50`, {
      headers: authHeaders(input.accessToken),
    }),
    fetch(`${baseUrl}/issues/${input.pullNumber}/comments?per_page=50`, {
      headers: authHeaders(input.accessToken),
    }),
  ]);

  const reviewComments = reviewRes.ok
    ? ((await reviewRes.json()) as Array<{
        id: number;
        user?: { login?: string } | null;
        body: string;
        path?: string;
        line?: number;
        original_line?: number;
        created_at: string;
        html_url: string;
      }>)
    : [];

  const issueComments = issueRes.ok
    ? ((await issueRes.json()) as Array<{
        id: number;
        user?: { login?: string } | null;
        body: string;
        created_at: string;
        html_url: string;
      }>)
    : [];

  return [
    ...reviewComments.map((c) => ({
      id: c.id,
      author: c.user?.login ?? "unknown",
      body: c.body,
      path: c.path ?? null,
      line: c.line ?? c.original_line ?? null,
      createdAt: c.created_at,
      htmlUrl: c.html_url,
      kind: "review" as const,
    })),
    ...issueComments.map((c) => ({
      id: c.id,
      author: c.user?.login ?? "unknown",
      body: c.body,
      path: null,
      line: null,
      createdAt: c.created_at,
      htmlUrl: c.html_url,
      kind: "issue" as const,
    })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getLatestGithubWorkflowRuns(
  input: GitHubRepoIdentity & {
    branch?: string;
    perPage?: number;
  },
): Promise<
  Array<{
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    headBranch: string;
    headSha: string;
    htmlUrl: string;
    createdAt: string;
  }>
> {
  const params = new URLSearchParams({
    per_page: String(input.perPage ?? 10),
  });
  if (input.branch) params.set("branch", input.branch);
  const url = `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}/actions/runs?${params.toString()}`;
  const response = await fetch(url, {
    headers: authHeaders(input.accessToken),
  });
  if (!response.ok) {
    const payload = await readJson<GitHubErrorPayload>(response);
    throw buildError(response, payload);
  }
  const data = (await response.json()) as {
    workflow_runs?: Array<{
      id: number;
      name: string;
      status: string;
      conclusion: string | null;
      head_branch: string;
      head_sha: string;
      html_url: string;
      created_at: string;
    }>;
  };
  return (data.workflow_runs ?? []).map((run) => ({
    id: run.id,
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    headBranch: run.head_branch,
    headSha: run.head_sha,
    htmlUrl: run.html_url,
    createdAt: run.created_at,
  }));
}
