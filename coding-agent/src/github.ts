import * as crypto from "crypto";

export interface ReviewComment {
  path: string;
  line: number | null;
  body: string;
  author: string;
}

export interface ReviewTask {
  prNumber: number;
  prTitle: string;
  prUrl: string;
  branch: string; // PR head ref
  baseBranch: string;
  ticketId: string | null; // extracted from title/branch, for logging/metadata
  reviewId: number; // the GitHub review id — used to dedup duplicate deliveries
  reviewer: string;
  reviewState: string; // "changes_requested" | "commented"
  reviewBody: string;
  comments: ReviewComment[];
}

export interface GithubReviewPayload {
  action: string;
  review: {
    id: number;
    state: string; // approved | changes_requested | commented | dismissed
    body: string | null;
    user: { login: string };
  };
  pull_request: {
    number: number;
    title: string;
    html_url: string;
    head: { ref: string };
    base: { ref: string };
  };
  repository: { full_name: string; owner: { login: string }; name: string };
}

/**
 * Verify a GitHub webhook using the X-Hub-Signature-256 header
 * ("sha256=<hex>"), HMAC-SHA256 over the raw request body.
 */
export function verifyGithubWebhook(
  rawBody: string,
  signature: string,
  secret: string
): boolean {
  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/** Agent-authored PR branches use these prefixes; ignore reviews on others. */
export function isAgentBranch(ref: string): boolean {
  return ref.startsWith("claude/") || ref.startsWith("linear/");
}

/**
 * A submitted review that asks for work: "changes_requested" or "commented".
 * Approvals and dismissals are ignored. Only acts on agent-authored branches.
 */
export function isReviewSubmitEvent(payload: GithubReviewPayload): boolean {
  return (
    payload.action === "submitted" &&
    ["changes_requested", "commented"].includes(payload.review?.state) &&
    isAgentBranch(payload.pull_request?.head?.ref ?? "")
  );
}

/** Extract a Linear identifier like "YTD-5" from the PR title or branch. */
function extractTicketId(title: string, branch: string): string | null {
  const m = `${title} ${branch}`.match(/[A-Z][A-Z0-9]+-\d+/);
  return m ? m[0] : null;
}

/**
 * Build a ReviewTask from a review-submit payload, fetching the inline comments
 * tied to this review from the GitHub API. Returns null if there is nothing
 * actionable (no body and no inline comments).
 */
export async function buildReviewTask(
  payload: GithubReviewPayload,
  token: string
): Promise<ReviewTask | null> {
  const pr = payload.pull_request;
  const [owner, repo] = payload.repository.full_name.split("/");

  const comments = await fetchReviewComments(
    owner,
    repo,
    pr.number,
    payload.review.id,
    token
  );
  const reviewBody = payload.review.body?.trim() ?? "";

  if (!reviewBody && comments.length === 0) return null;

  return {
    prNumber: pr.number,
    prTitle: pr.title,
    prUrl: pr.html_url,
    branch: pr.head.ref,
    baseBranch: pr.base.ref,
    ticketId: extractTicketId(pr.title, pr.head.ref),
    reviewId: payload.review.id,
    reviewer: payload.review.user.login,
    reviewState: payload.review.state,
    reviewBody,
    comments,
  };
}

async function fetchReviewComments(
  owner: string,
  repo: string,
  prNumber: number,
  reviewId: number,
  token: string
): Promise<ReviewComment[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${reviewId}/comments`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    console.error(`GitHub review-comments fetch failed: ${res.status} ${res.statusText}`);
    return [];
  }
  const data = (await res.json()) as Array<{
    path: string;
    line: number | null;
    original_line: number | null;
    body: string;
    user: { login: string };
  }>;
  return data.map((c) => ({
    path: c.path,
    line: c.line ?? c.original_line ?? null,
    body: c.body,
    author: c.user.login,
  }));
}
