# Deploying the webhook server (always-on)

The webhook server is a thin relay: it receives Linear/GitHub webhooks and starts
agent sessions on Anthropic's cloud (the agent itself does not run here). Hosting
it on a small always-on service means webhooks work without your laptop.

This repo includes a [`render.yaml`](../render.yaml) blueprint for [Render](https://render.com),
but any Node host (Railway, Fly.io, a VM) works the same way: build with
`npm run build`, start with `npm start`, and set the env vars below.

## Deploy to Render

1. Push this repo to GitHub (already done).
2. In Render: **New + → Blueprint**, select this repo. Render reads `render.yaml`
   and creates the `blueberry-coding-agent` web service (root dir `coding-agent`).
3. Set the secret env vars in the service's **Environment** tab (the blueprint
   lists them with `sync: false`, so Render prompts for each):

   | Variable | Where it comes from |
   |---|---|
   | `ANTHROPIC_API_KEY` | Anthropic console |
   | `AGENT_ID` / `ENVIRONMENT_ID` / `VAULT_ID` | printed by `npm run setup` |
   | `LINEAR_WEBHOOK_SECRET` | Linear webhook settings |
   | `LINEAR_API_TOKEN` | Linear API settings |
   | `GITHUB_TOKEN` | fine-grained PAT scoped to the target repo |
   | `GITHUB_WEBHOOK_SECRET` | the secret you set on the GitHub webhook |

   `LINEAR_AGENT_LABEL` defaults to `agent` (already in the blueprint).
   `PORT` is provided by Render automatically — don't set it.
4. Deploy. Render gives you a permanent URL like
   `https://blueberry-coding-agent.onrender.com`.

## Point the webhooks at the new URL

Replace the temporary tunnel URL in both places:

- **Linear** webhook → `https://<your-service>.onrender.com/webhook/linear`
- **GitHub** (blueberry repo) webhook → `https://<your-service>.onrender.com/webhook/github`

Then you can stop the local `npm run dev` server and the `cloudflared` tunnel.

## Free plan caveat

Render's free plan spins the service down after ~15 min idle (~1 min cold start
on the next request). **GitHub does not auto-retry failed webhook deliveries**, so
an event arriving during a cold start can be missed (redeliver it manually from
the webhook's Recent Deliveries). For reliable delivery, set `plan: starter` in
`render.yaml` (always warm).
