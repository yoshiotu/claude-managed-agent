import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.js";
import type { LinearTicket } from "./linear.js";

export async function runTicketSession(
  client: Anthropic,
  config: Config,
  ticket: LinearTicket
): Promise<void> {
  console.log(`[${ticket.identifier}] Starting session for: ${ticket.title}`);

  // Create session — attach the blueberry repo, reference the vault for GitHub MCP auth
  const session = await client.beta.sessions.create({
    agent: config.AGENT_ID,
    environment_id: config.ENVIRONMENT_ID,
    title: `${ticket.identifier}: ${ticket.title}`,
    vault_ids: [config.VAULT_ID],
    resources: [
      {
        type: "github_repository",
        url: "https://github.com/yoshiotu/blueberry",
        authorization_token: config.GITHUB_TOKEN,
        checkout: { type: "branch", name: "main" },
      },
    ],
    metadata: {
      linear_ticket_id: ticket.id,
      linear_identifier: ticket.identifier,
    },
  });

  console.log(
    `[${ticket.identifier}] Session created: ${session.id}`
  );
  console.log(
    `[${ticket.identifier}] Watch live: https://platform.claude.com/workspaces/default/sessions/${session.id}`
  );

  // Open event stream BEFORE sending the kickoff message
  const stream = await client.beta.sessions.events.stream(session.id);

  // Kick off with a structured outcome so the agent iterates until tests pass + PR opened
  const rubric = buildRubric(ticket);
  await client.beta.sessions.events.send(session.id, {
    events: [
      {
        type: "user.define_outcome",
        description: buildTaskDescription(ticket),
        rubric: { type: "text", content: rubric },
        max_iterations: 5,
      },
    ],
  });

  // Drain the event stream
  const seenIds = new Set<string>();

  for await (const event of stream) {
    if (seenIds.has(event.id)) continue;
    seenIds.add(event.id);

    switch (event.type) {
      case "agent.message":
        process.stdout.write(`\n[${ticket.identifier}] Agent: `);
        for (const block of event.content ?? []) {
          if ("text" in block) process.stdout.write(block.text);
        }
        process.stdout.write("\n");
        break;

      case "agent.tool_use":
        console.log(`[${ticket.identifier}] Tool: ${event.name}`);
        break;

      case "session.status_idle":
        if (event.stop_reason?.type === "requires_action") {
          // The agent is blocked on tool confirmations. We trust this agent's
          // toolset, so auto-approve every pending tool call and let it resume.
          const eventIds = event.stop_reason.event_ids ?? [];
          if (eventIds.length > 0) {
            console.log(
              `[${ticket.identifier}] Auto-approving ${eventIds.length} pending tool call(s).`
            );
            await client.beta.sessions.events.send(session.id, {
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
        console.log(`[${ticket.identifier}] Session terminated.`);
        break;

      case "session.error":
        console.error(`[${ticket.identifier}] Session error:`, event);
        break;

      case "span.outcome_evaluation_end":
        console.log(
          `[${ticket.identifier}] Outcome (iter ${event.iteration}): ${event.result}`
        );
        if (event.result === "satisfied") {
          console.log(`[${ticket.identifier}] ✓ Done: ${event.explanation}`);
        }
        break;
    }

    // Break on terminal states
    if (event.type === "session.status_terminated") break;
    if (
      event.type === "session.status_idle" &&
      event.stop_reason?.type !== "requires_action"
    ) break;
  }

  console.log(`[${ticket.identifier}] Session complete.`);
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
- [ ] Branch is named \`linear/${ticket.identifier.toLowerCase()}\`.
- [ ] PR description summarises the change.
`;
}
