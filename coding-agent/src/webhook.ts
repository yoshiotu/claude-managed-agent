import express from "express";
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
import { runTicketSession, runReviewFixSession } from "./session.js";

const config = loadConfig();
const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const app = express();

// Parse raw body for HMAC verification
app.use(
  express.json({
    verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.post("/webhook/linear", (req, res) => {
  const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody;
  const signature = req.headers["linear-signature"] as string | undefined;

  if (!rawBody || !signature) {
    res.status(400).json({ error: "Missing body or signature" });
    return;
  }

  if (!verifyLinearWebhook(rawBody.toString(), signature, config.LINEAR_WEBHOOK_SECRET)) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const payload = req.body as LinearWebhookPayload;

  if (!isAgentTriggerEvent(payload, config.LINEAR_AGENT_LABEL)) {
    res.json({ ok: true, skipped: true });
    return;
  }

  const ticket = ticketFromPayload(payload);
  console.log(`Received ticket assignment: ${ticket.identifier} — ${ticket.title}`);

  // Acknowledge immediately; run session in background
  res.json({ ok: true, ticket: ticket.identifier });

  runTicketSession(client, config, ticket).catch((err) => {
    console.error(`Session failed for ${ticket.identifier}:`, err);
  });
});

app.post("/webhook/github", (req, res) => {
  const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody;
  const signature = req.headers["x-hub-signature-256"] as string | undefined;
  const ghEvent = req.headers["x-github-event"] as string | undefined;

  if (!rawBody || !signature) {
    res.status(400).json({ error: "Missing body or signature" });
    return;
  }

  if (!verifyGithubWebhook(rawBody.toString(), signature, config.GITHUB_WEBHOOK_SECRET)) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  console.log(`GitHub webhook received: event=${ghEvent}`);

  // GitHub sends a "ping" when the webhook is created.
  if (ghEvent === "ping") {
    res.json({ ok: true, pong: true });
    return;
  }

  if (ghEvent !== "pull_request_review") {
    console.log(`  -> skipped (event type "${ghEvent}" is not handled)`);
    res.json({ ok: true, skipped: "event" });
    return;
  }

  const payload = req.body as GithubReviewPayload;

  console.log(
    `GitHub review webhook: action=${payload.action} state=${payload.review?.state} ` +
      `branch=${payload.pull_request?.head?.ref} pr=#${payload.pull_request?.number}`
  );

  if (!isReviewSubmitEvent(payload)) {
    console.log(`  -> skipped (not an actionable review on an agent branch)`);
    res.json({ ok: true, skipped: true });
    return;
  }

  console.log(
    `Received review on PR #${payload.pull_request.number} (${payload.review.state}) by ${payload.review.user.login}`
  );

  // Acknowledge immediately; build the task and run the fix session in background.
  res.json({ ok: true, pr: payload.pull_request.number });

  (async () => {
    const task = await buildReviewTask(payload, config.GITHUB_TOKEN);
    if (!task) {
      console.log(`PR #${payload.pull_request.number}: no actionable feedback, skipping.`);
      return;
    }
    await runReviewFixSession(client, config, task);
  })().catch((err) => {
    console.error(`Review-fix failed for PR #${payload.pull_request.number}:`, err);
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(config.PORT, () => {
  console.log(`Coding agent webhook listening on port ${config.PORT}`);
});
