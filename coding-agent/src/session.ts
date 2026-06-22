import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.js";
import type { LinearTicket } from "./linear.js";
import type { ReviewTask } from "./github.js";

const REPO_URL = "https://github.com/yoshiotu/blueberry";

/**
 * Implement a Linear ticket: branch off main, write code + tests, open a PR.
 */
export async function runTicketSession(
  client: Anthropic,
  config: Config,
  ticket: LinearTicket
): Promise<void> {
  const label = ticket.identifier;
  console.log(`[${label}] Starting session for: ${ticket.title}`);

  const session = await client.beta.sessions.create({
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
  });

  await kickoffAndDrive(client, session.id, label, {
    description: buildTaskDescription(ticket),
    rubric: buildRubric(ticket),
  });
}

/**
 * Revise an existing PR in response to a submitted review: the repo is checked
 * out on the PR branch; address the comments and push to the same branch.
 */
export async function runReviewFixSession(
  client: Anthropic,
  config: Config,
  task: ReviewTask
): Promise<void> {
  const label = `PR#${task.prNumber}`;
  console.log(`[${label}] Starting review-fix session (${task.comments.length} comment(s))`);

  const session = await client.beta.sessions.create({
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
      branch: task.branch,
      ...(task.ticketId ? { linear_identifier: task.ticketId } : {}),
    },
  });

  await kickoffAndDrive(client, session.id, label, {
    description: buildReviewFixDescription(task),
    rubric: buildReviewFixRubric(task),
  });
}

/**
 * Shared driver: open the stream, send the kickoff outcome, and drain events
 * until the session reaches a terminal state. Auto-approves tool confirmations.
 */
async function kickoffAndDrive(
  client: Anthropic,
  sessionId: string,
  label: string,
  outcome: { description: string; rubric: string }
): Promise<void> {
  console.log(`[${label}] Session created: ${sessionId}`);
  console.log(
    `[${label}] Watch live: https://platform.claude.com/workspaces/default/sessions/${sessionId}`
  );

  // Open the event stream BEFORE sending the kickoff so no events are missed.
  const stream = await client.beta.sessions.events.stream(sessionId);

  await client.beta.sessions.events.send(sessionId, {
    events: [
      {
        type: "user.define_outcome",
        description: outcome.description,
        rubric: { type: "text", content: outcome.rubric },
        max_iterations: 5,
      },
    ],
  });

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
          // Auto-approve pending tool calls — we trust this agent's toolset.
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
