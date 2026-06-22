import "dotenv/config";
import { z } from "zod";

const ConfigSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  AGENT_ID: z.string().min(1),
  ENVIRONMENT_ID: z.string().min(1),
  VAULT_ID: z.string().min(1),
  LINEAR_WEBHOOK_SECRET: z.string().min(1),
  LINEAR_API_TOKEN: z.string().min(1),
  LINEAR_AGENT_LABEL: z.string().min(1).default("agent"),
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  PORT: z.coerce.number().default(3000),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Missing required environment variables:");
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  return result.data;
}
