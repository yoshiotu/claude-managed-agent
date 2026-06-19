/**
 * One-time setup: creates the Managed Agent, environment, and vault.
 * Run once: npm run setup
 * Then paste the printed IDs into your .env file.
 */
import "dotenv/config";
import Anthropic, { type Uploadable, toFile } from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is required");
  process.exit(1);
}

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

async function setup() {
  console.log("Setting up blueberry coding agent...\n");

  // 1. Create environment
  console.log("Creating environment...");
  const env = await client.beta.environments.create({
    name: "blueberry-dev",
    config: { type: "cloud", networking: { type: "unrestricted" } },
  });
  console.log(`  Environment ID: ${env.id}`);

  // 2. Create vault for GitHub MCP credentials
  console.log("Creating vault...");
  const vault = await client.beta.vaults.create({
    display_name: "blueberry-credentials",
  });
  console.log(`  Vault ID: ${vault.id}`);

  // 3. Add GitHub MCP credential to vault
  const githubMcpToken = process.env.GITHUB_MCP_TOKEN;

  if (githubMcpToken) {
    console.log("Adding GitHub MCP credential to vault...");
    await client.beta.vaults.credentials.create(vault.id, {
      display_name: "GitHub Copilot MCP",
      auth: {
        type: "static_bearer",
        mcp_server_url: "https://api.githubcopilot.com/mcp/",
        token: githubMcpToken,
      },
    });
    console.log("  GitHub MCP credential added.");
  } else {
    console.warn(
      "  Skipping GitHub MCP credential — set GITHUB_MCP_TOKEN to add it."
    );
  }

  // 4. Upload skills — each file uploaded individually under its skill directory
  console.log("Uploading skills...");
  const skillsDir = path.join(__dirname, "../skills");
  const skillIds: Record<string, string> = {};

  for (const skillName of ["coding-standards", "testing-practices"]) {
    const skillDir = path.join(skillsDir, skillName);
    if (!fs.existsSync(skillDir)) continue;

    // Collect all files in the skill directory as Uploadable entries.
    // The API requires them all under one top-level directory with SKILL.md present.
    const files: Uploadable[] = [];
    for (const filename of fs.readdirSync(skillDir)) {
      const filePath = path.join(skillDir, filename);
      if (!fs.statSync(filePath).isFile()) continue;
      const buf = fs.readFileSync(filePath);
      files.push(
        await toFile(buf, `${skillName}/${filename}`, { type: "text/markdown" })
      );
    }

    // skills.create uploads display_title + the first version's files in one call.
    const skill = await client.beta.skills.create({
      display_title: skillName,
      files,
    });

    skillIds[skillName] = skill.id;
    console.log(`  Skill "${skillName}": ${skill.id}`);
  }

  // 5. Create agent
  console.log("Creating agent...");
  const systemPrompt = fs.readFileSync(
    path.join(__dirname, "../agent-system-prompt.txt"),
    "utf8"
  );
  const agent = await client.beta.agents.create({
    name: "blueberry-coding-agent",
    model: "claude-opus-4-8",
    description:
      "Autonomous coding agent that implements Linear tickets on yoshiotu/blueberry",
    system: systemPrompt,
    tools: [
      { type: "agent_toolset_20260401" },
      {
        type: "mcp_toolset",
        mcp_server_name: "github",
        // Trusted server — auto-approve so the agent runs autonomously.
        default_config: { permission_policy: { type: "always_allow" } },
      },
    ],
    mcp_servers: [
      {
        type: "url",
        name: "github",
        url: "https://api.githubcopilot.com/mcp/",
      },
    ],
    skills: Object.entries(skillIds).map(([, id]) => ({
      type: "custom" as const,
      skill_id: id,
    })),
  });
  console.log(`  Agent ID: ${agent.id}`);

  // 6. Print summary
  console.log("\n========================================");
  console.log("Setup complete! Add these to your .env:");
  console.log("========================================");
  console.log(`AGENT_ID=${agent.id}`);
  console.log(`ENVIRONMENT_ID=${env.id}`);
  console.log(`VAULT_ID=${vault.id}`);
  console.log("========================================\n");
}

setup().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
