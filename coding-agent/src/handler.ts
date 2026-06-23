/**
 * AWS Lambda handler for the coding-agent webhooks (Linear + GitHub).
 *
 * Designed for a Lambda Function URL (payload format v2.0). It verifies the
 * webhook signature, applies the trigger filter, creates a Managed Agents
 * session, sends the kickoff outcome, and returns — fire-and-forget. The agent
 * then runs to completion on Anthropic's cloud on its own.
 *
 * Routes (append the path to the Function URL):
 *   POST /webhook/linear
 *   POST /webhook/github
 *   GET  /health
 */
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "./config.js";
import {
  verifyLinearWebhook,
  isAgentTriggerEvent,
  ticketFromPayload,
  type LinearWebhookPayload,
} from "./linear.js";
import {
  verifyGithubWebhook,
  isReviewSubmitEvent,
  buildReviewTask,
  type GithubReviewPayload,
} from "./github.js";
import { startTicketSession, startReviewFixSession } from "./session.js";

// Initialized once per execution environment and reused across warm invocations.
const config = loadConfig();
const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

interface FunctionUrlEvent {
  rawPath?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string } };
}

interface LambdaResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function reply(statusCode: number, obj: unknown): LambdaResponse {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(obj),
  };
}

function lowerKeys(
  headers: Record<string, string | undefined>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v != null) out[k.toLowerCase()] = v;
  }
  return out;
}

export async function handler(event: FunctionUrlEvent): Promise<LambdaResponse> {
  const path = event.rawPath ?? "/";
  const method = event.requestContext?.http?.method ?? "GET";

  if (method === "GET" && path.endsWith("/health")) {
    return reply(200, { ok: true });
  }
  if (method !== "POST") {
    return reply(405, { error: "method not allowed" });
  }

  const raw = event.body
    ? event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body
    : "";
  const headers = lowerKeys(event.headers ?? {});

  try {
    if (path.endsWith("/webhook/linear")) {
      return await handleLinear(raw, headers);
    }
    if (path.endsWith("/webhook/github")) {
      return await handleGithub(raw, headers);
    }
  } catch (err) {
    console.error("Handler error:", err);
    return reply(500, { error: "internal error" });
  }

  return reply(404, { error: "not found" });
}

async function handleLinear(
  raw: string,
  headers: Record<string, string>
): Promise<LambdaResponse> {
  const signature = headers["linear-signature"];
  if (!raw || !signature) return reply(400, { error: "missing body or signature" });
  if (!verifyLinearWebhook(raw, signature, config.LINEAR_WEBHOOK_SECRET)) {
    return reply(401, { error: "invalid signature" });
  }

  const payload = JSON.parse(raw) as LinearWebhookPayload;
  if (!isAgentTriggerEvent(payload, config.LINEAR_AGENT_LABEL)) {
    return reply(200, { ok: true, skipped: true });
  }

  const ticket = ticketFromPayload(payload);
  console.log(`Ticket trigger: ${ticket.identifier} — ${ticket.title}`);
  const sessionId = await startTicketSession(client, config, ticket);
  if (!sessionId) {
    return reply(200, { ok: true, ticket: ticket.identifier, skipped: "duplicate" });
  }
  return reply(200, { ok: true, ticket: ticket.identifier, session: sessionId });
}

async function handleGithub(
  raw: string,
  headers: Record<string, string>
): Promise<LambdaResponse> {
  const signature = headers["x-hub-signature-256"];
  const ghEvent = headers["x-github-event"];
  if (!raw || !signature) return reply(400, { error: "missing body or signature" });
  if (!verifyGithubWebhook(raw, signature, config.GITHUB_WEBHOOK_SECRET)) {
    return reply(401, { error: "invalid signature" });
  }

  if (ghEvent === "ping") return reply(200, { ok: true, pong: true });
  if (ghEvent !== "pull_request_review") {
    return reply(200, { ok: true, skipped: "event" });
  }

  const payload = JSON.parse(raw) as GithubReviewPayload;
  if (!isReviewSubmitEvent(payload)) {
    return reply(200, { ok: true, skipped: true });
  }

  const task = await buildReviewTask(payload, config.GITHUB_TOKEN);
  if (!task) {
    return reply(200, { ok: true, skipped: "no actionable feedback" });
  }

  console.log(`Review trigger: PR #${task.prNumber} (${task.reviewState}) by ${task.reviewer}`);
  const sessionId = await startReviewFixSession(client, config, task);
  if (!sessionId) {
    return reply(200, { ok: true, pr: task.prNumber, skipped: "duplicate" });
  }
  return reply(200, { ok: true, pr: task.prNumber, session: sessionId });
}
