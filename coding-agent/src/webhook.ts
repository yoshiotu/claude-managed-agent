import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "./config.js";
import {
  verifyLinearWebhook,
  isAgentTriggerEvent,
  ticketFromPayload,
  type LinearWebhookPayload,
} from "./linear.js";
import { runTicketSession } from "./session.js";

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

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(config.PORT, () => {
  console.log(`Coding agent webhook listening on port ${config.PORT}`);
});
