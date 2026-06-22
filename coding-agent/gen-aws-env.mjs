/**
 * Generate aws-env.json (the --environment payload for the Lambda) from .env,
 * including only the variables the running handler needs.
 *
 *   node gen-aws-env.mjs
 *   aws lambda update-function-configuration \
 *     --function-name blueberry-coding-agent --environment file://aws-env.json
 *
 * aws-env.json is gitignored — it contains secrets.
 */
import * as fs from "fs";

// Runtime config keys (see src/config.ts). GITHUB_MCP_TOKEN and PORT are omitted:
// the former is only used by setup; PORT is provided by Lambda.
const RUNTIME_KEYS = [
  "ANTHROPIC_API_KEY",
  "AGENT_ID",
  "ENVIRONMENT_ID",
  "VAULT_ID",
  "LINEAR_WEBHOOK_SECRET",
  "LINEAR_API_TOKEN",
  "LINEAR_AGENT_LABEL",
  "GITHUB_TOKEN",
  "GITHUB_WEBHOOK_SECRET",
];

const env = {};
for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  const value = trimmed.slice(eq + 1).trim();
  if (RUNTIME_KEYS.includes(key) && value) env[key] = value;
}

const missing = RUNTIME_KEYS.filter((k) => k !== "LINEAR_AGENT_LABEL" && !(k in env));
if (missing.length) {
  console.error(`Missing required keys in .env: ${missing.join(", ")}`);
  process.exit(1);
}

fs.writeFileSync("aws-env.json", JSON.stringify({ Variables: env }, null, 2));
console.log(`Wrote aws-env.json with ${Object.keys(env).length} variables.`);
