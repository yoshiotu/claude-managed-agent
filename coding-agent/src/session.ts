import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.js";
import type { LinearTicket } from "./linear.js";
import type { ReviewTask } from "./github.js";

const REPO_URL = "https://github.com/yoshiotu/blueberry";

// Window for treating a repeat trigger as a duplicate. Linear can emit both a
// create and a label-added update for one ticket; webhooks can also be retried.
const DEDUP_WINDOW_MS = 10 * 60 * 1000;

type SessionParams = Parameters<Anthropic["beta"]["sessions"]["create"]>[0];

/**
 * True if a session created within the dedup window already matches `match`
 * (by metadata). Used to avoid spawning a second run for the same trigger.
 */
async function recentDuplicateExists(
  client: Anthropic,
  config: Config,
  match: (metadata: Record<string, string>) => boolean
): Promise<boolean> {
  const since = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();
  const page = await client.beta.sessions.list({
    agent_id: config.AGENT_ID,
    "created_at[gte]": since,
  });
  for await (const session of page) {
    if (match(session.metadata ?? {})) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Fire-and-forget starters (used by the Lambda handler).
// Create the session and send the kickoff outcome, then return. The agent runs
// to completion autonomously on Anthropic's cloud (the MCP toolset is
// always_allow, so it never pauses for confirmations). Observe runs in the
// Claude session viewer.
// ---------------------------------------------------------------------------

export async function startTicketSession(
  client: Anthropic,
  config: Config,
  ticket: LinearTicket
): Promise<string | null> {
  if (await recentDuplicateExists(client, config, (m) => m.linear_identifier === ticket.identifier)) {
    console.log(`[${ticket.identifier}] Duplicate trigger — a recent session already exists. Skipping.`);
    return null;
  }
  const session = await client.beta.sessions.create(ticketSessionParams(config, ticket));
  logCreated(ticket.identifier, session.id);
  await sendOutcome(client, session.id, buildTaskDescription(ticket), buildRubric(ticket));
  return session.id;
}

export async function startReviewFixSession(
  client: Anthropic,
  config: Config,
  task: ReviewTask
): Promise<string | null> {
  if (await recentDuplicateExists(client, config, (m) => m.review_id === String(task.reviewId))) {
    console.log(`[PR#${task.prNumber}] Duplicate review delivery — a recent session already exists. Skipping.`);
    return null;
  }
  const session = await client.beta.sessions.create(reviewSessionParams(config, task));
  logCreated(`PR#${task.prNumber}`, session.id);
  await sendOutcome(
    client,
    session.id,
    buildReviewFixDescription(task),
    buildReviewFixRubric(task)
  );
  return session.id;
}

// ---------------------------------------------------------------------------
// Drive variants (used by the local Express dev server for live logging).
// Same kickoff, but they stream the event log to stdout until the session ends.
// ---------------------------------------------------------------------------

export async function runTicketSession(
  client: Anthropic,
  config: Config,
  ticket: LinearTicket
): Promise<void> {
  if (await recentDuplicateExists(client, config, (m) => m.linear_identifier === ticket.identifier)) {
    console.log(`[${ticket.identifier}] Duplicate trigger — a recent session already exists. Skipping.`);
    return;
  }
  const session = await client.beta.sessions.create(ticketSessionParams(config, ticket));
  logCreated(ticket.identifier, session.id);
  const stream = await client.beta.sessions.events.stream(session.id);
  await sendOutcome(client, session.id, buildTaskDescription(ticket), buildRubric(ticket));
  await drive(client, session.id, ticket.identifier, stream);
}

export async function runReviewFixSession(
  client: Anthropic,
  config: Config,
  task: ReviewTask
): Promise<void> {
  if (await recentDuplicateExists(client, config, (m) => m.review_id === String(task.reviewId))) {
    console.log(`[PR#${task.prNumber}] Duplicate review delivery — a recent session already exists. Skipping.`);
    return;
  }
  const session = await client.beta.sessions.create(reviewSessionParams(config, task));
  logCreated(`PR#${task.prNumber}`, session.id);
  const stream = await client.beta.sessions.events.stream(session.id);
  await sendOutcome(
    client,
    session.id,
    buildReviewFixDescription(task),
    buildReviewFixRubric(task)
  );
  await drive(client, session.id, `PR#${task.prNumber}`, stream);
}

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

function ticketSessionParams(config: Config, ticket: LinearTicket): SessionParams {
  return {
    agent: config.AGENT_ID,
    environment_id: config.ENVIRONMENT_ID,
    title: `${ticket.identifier}: ${ticket.title}`,
    vault_ids: [config.VAULT_ID],
    resources: [
      {
        type: "github_repository",
        url: REPO_URL,
        authorization_token: config.GITHUB_TOKEN,
        checkout: { type: "branch", name: "main" },
      },
    ],
    metadata: {
      linear_ticket_id: ticket.id,
      linear_identifier: ticket.identifier,
    },
  };
}

function reviewSessionParams(config: Config, task: ReviewTask): SessionParams {
  return {
    agent: config.AGENT_ID,
    environment_id: config.ENVIRONMENT_ID,
    title: `Review fix: PR #${task.prNumber}`,
    vault_ids: [config.VAULT_ID],
    resources: [
      {
        type: "github_repository",
        url: REPO_URL,
        authorization_token: config.GITHUB_TOKEN,
        checkout: { type: "branch", name: task.branch },
      },
    ],
    metadata: {
      pr_number: String(task.prNumber),
      review_id: String(task.reviewId),
      branch: task.branch,
      ...(task.ticketId ? { linear_identifier: task.ticketId } : {}),
    },
  };
}

async function sendOutcome(
  client: Anthropic,
  sessionId: string,
  description: string,
  rubric: string
): Promise<void> {
  await client.beta.sessions.events.send(sessionId, {
    events: [
      {
        type: "user.define_outcome",
        description,
        rubric: { type: "text", content: rubric },
        max_iterations: 5,
      },
    ],
  });
}

function logCreated(label: string, sessionId: string): void {
  console.log(`[${label}] Session created: ${sessionId}`);
  console.log(
    `[${label}] Watch live: https://platform.claude.com/workspaces/default/sessions/${sessionId}`
  );
}

/** Drain the event stream to stdout until the session reaches a terminal state. */
async function drive(
  client: Anthropic,
  sessionId: string,
  label: string,
  stream: Awaited<ReturnType<Anthropic["beta"]["sessions"]["events"]["stream"]>>
): Promise<void> {
  const seenIds = new Set<string>();

  for await (const event of stream) {
    if (seenIds.has(event.id)) continue;
    seenIds.add(event.id);

    switch (event.type) {
      case "agent.message":
        process.stdout.write(`\n[${label}] Agent: `);
        for (const block of event.content ?? []) {
          if ("text" in block) process.stdout.write(block.text);
        }
        process.stdout.write("\n");
        break;

      case "agent.tool_use":
        console.log(`[${label}] Tool: ${event.name}`);
        break;

      case "session.status_idle":
        if (event.stop_reason?.type === "requires_action") {
          const eventIds = event.stop_reason.event_ids ?? [];
          if (eventIds.length > 0) {
            console.log(`[${label}] Auto-approving ${eventIds.length} pending tool call(s).`);
            await client.beta.sessions.events.send(sessionId, {
              events: eventIds.map((id) => ({
                type: "user.tool_confirmation" as const,
                tool_use_id: id,
                result: "allow" as const,
              })),
            });
          }
        }
        break;

      case "session.status_terminated":
        console.log(`[${label}] Session terminated.`);
        break;

      case "session.error":
        console.error(`[${label}] Session error:`, event);
        break;

      case "span.outcome_evaluation_end":
        console.log(`[${label}] Outcome (iter ${event.iteration}): ${event.result}`);
        if (event.result === "satisfied") {
          console.log(`[${label}] ✓ Done: ${event.explanation}`);
        }
        break;
    }

    if (event.type === "session.status_terminated") break;
    if (
      event.type === "session.status_idle" &&
      event.stop_reason?.type !== "requires_action"
    ) break;
  }

  console.log(`[${label}] Session complete.`);
}

// ---------------------------------------------------------------------------
// Task descriptions + rubrics
// ---------------------------------------------------------------------------

function buildTaskDescription(ticket: LinearTicket): string {
  return [
    `Implement the following Linear ticket in the yoshiotu/blueberry repository.`,
    ``,
    `Ticket: ${ticket.identifier}`,
    `Title: ${ticket.title}`,
    ticket.description ? `Description:\n${ticket.description}` : "",
    ``,
    `Linear URL: ${ticket.url}`,
  ]
    .filter((l) => l !== undefined)
    .join("\n");
}

function buildRubric(ticket: LinearTicket): string {
  return `# Done criteria for ${ticket.identifier}

## Implementation
- [ ] Code satisfies the requirements described in the ticket title and description.
- [ ] No existing tests are broken.
- [ ] New unit tests cover the changed/added code (≥ 80% line coverage on new code).

## Quality
- [ ] Code follows the project coding standards skill.
- [ ] No dead code, unused imports, or commented-out blocks.

## Pull Request
- [ ] A pull request has been opened on yoshiotu/blueberry.
- [ ] PR title references the Linear ticket identifier (${ticket.identifier}).
- [ ] PR description summarises the change.
`;
}

function buildReviewFixDescription(task: ReviewTask): string {
  const inline = task.comments.length
    ? task.comments
        .map((c) => `- ${c.path}${c.line != null ? `:${c.line}` : ""} — ${c.body}`)
        .join("\n")
    : "(none)";

  return [
    `A reviewer (${task.reviewer}) submitted a "${task.reviewState}" review on`,
    `pull request #${task.prNumber} in yoshiotu/blueberry, which you previously opened.`,
    `The repository is already checked out on the PR branch \`${task.branch}\`.`,
    ``,
    `Address every actionable point of the review feedback below. Then commit your`,
    `changes and push to the SAME branch \`${task.branch}\` — this updates the existing`,
    `PR. Do NOT open a new pull request. Keep all tests passing and follow the`,
    `coding-standards and testing-practices skills.`,
    ``,
    `PR: ${task.prUrl}`,
    ``,
    `Review summary:`,
    task.reviewBody || "(no summary text)",
    ``,
    `Inline comments:`,
    inline,
    ``,
    `If a comment is a question or you disagree, make the change if reasonable;`,
    `otherwise explain your reasoning. When done, summarize what you changed for`,
    `each comment.`,
  ].join("\n");
}

function buildReviewFixRubric(task: ReviewTask): string {
  return `# Done criteria for PR #${task.prNumber} review fixes

## Feedback
- [ ] Every actionable review comment is addressed in the code (or explicitly justified if not).

## Quality
- [ ] All existing tests still pass.
- [ ] Changed code keeps ≥ 80% line coverage and follows the coding standards skill.

## Delivery
- [ ] Changes are committed and pushed to the existing branch \`${task.branch}\`.
- [ ] No new pull request was opened; the existing PR #${task.prNumber} is updated.
`;
}
