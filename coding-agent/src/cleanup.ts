/**
 * Cleanup helper: removes debugging artifacts left over from setup iterations.
 *
 *   npm run cleanup           # dry run — lists what WOULD be deleted
 *   npm run cleanup -- --apply  # actually delete
 *
 * It is intentionally conservative:
 *   - Skills:  deletes only custom skills whose title starts with "exp-".
 *   - Vaults:  deletes "blueberry-credentials" vaults that are NOT the one in .env.
 *   - Envs:    reported only — the API has no delete endpoint for environments.
 *
 * The agent, environment, vault, and skills referenced by your .env are never touched.
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const apply = process.argv.includes("--apply");

const KEEP_VAULT = process.env.VAULT_ID;
const KEEP_ENV = process.env.ENVIRONMENT_ID;

async function cleanup() {
  console.log(apply ? "APPLYING cleanup...\n" : "DRY RUN (pass --apply to delete)\n");

  // 1. Skills — delete experiment skills ("exp-*"). A skill can only be deleted
  // after all of its versions are removed, so we delete versions first.
  console.log("=== Skills ===");
  for await (const s of client.beta.skills.list({ source: "custom" })) {
    if (!s.display_title?.startsWith("exp-")) {
      console.log(`  keep   skill ${s.id} "${s.display_title}"`);
      continue;
    }
    console.log(`  delete skill ${s.id} "${s.display_title}"`);
    if (!apply) continue;
    try {
      for await (const v of client.beta.skills.versions.list(s.id)) {
        await client.beta.skills.versions.delete(v.version, { skill_id: s.id });
      }
      await client.beta.skills.delete(s.id);
    } catch (e) {
      console.error(`    ! failed: ${(e as Error).message}`);
    }
  }

  // 2. Vaults — delete duplicate "blueberry-credentials" vaults except the one in .env
  console.log("\n=== Vaults ===");
  for await (const v of client.beta.vaults.list()) {
    const isDup =
      v.display_name === "blueberry-credentials" && v.id !== KEEP_VAULT;
    if (isDup) {
      console.log(`  delete vault ${v.id} "${v.display_name}"`);
      if (apply) {
        try {
          await client.beta.vaults.delete(v.id);
        } catch (e) {
          console.error(`    ! failed: ${(e as Error).message}`);
        }
      }
    } else {
      console.log(`  keep   vault ${v.id} "${v.display_name}"`);
    }
  }

  // 3. Environments — reported only (no delete endpoint)
  console.log("\n=== Environments (no API delete — remove via console if desired) ===");
  for await (const e of client.beta.environments.list()) {
    const dup = e.name === "blueberry-dev" && e.id !== KEEP_ENV;
    console.log(`  ${dup ? "orphan" : "keep  "} env ${e.id} "${e.name}"`);
  }

  console.log(apply ? "\nCleanup applied." : "\nDry run complete. Re-run with --apply to delete.");
}

cleanup().catch((err) => {
  console.error("Cleanup failed:", err);
  process.exit(1);
});
