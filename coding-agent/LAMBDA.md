# Deploying the webhook receiver to AWS Lambda

The webhook receiver runs as a single Lambda behind a **Function URL** (HTTPS,
always-on, no servers to manage). It verifies the webhook signature, creates a
Managed Agents session, and returns — the agent then runs to completion on
Anthropic's cloud. View runs in the Claude session viewer (and CloudWatch logs).

Prereqs: the AWS CLI configured (`aws sts get-caller-identity` works), and a
populated `.env`.

## 1. Build the package and env file

```bash
cd coding-agent
npm install
npm run package:lambda      # -> lambda.zip (bundled handler, ~170KB)
node gen-aws-env.mjs        # -> aws-env.json (runtime env vars from .env; gitignored)
```

## 2. Create an execution role (one-time)

```bash
aws iam create-role --role-name blueberry-coding-agent-role \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

aws iam attach-role-policy --role-name blueberry-coding-agent-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
```

The handler only calls the internet (Anthropic + GitHub APIs), so basic
execution (CloudWatch logs) is all it needs.

## 3. Create the function

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

aws lambda create-function \
  --function-name blueberry-coding-agent \
  --runtime nodejs20.x \
  --handler handler.handler \
  --role "arn:aws:iam::${ACCOUNT_ID}:role/blueberry-coding-agent-role" \
  --zip-file fileb://lambda.zip \
  --timeout 30 --memory-size 256

# Wait until Active, then set env vars:
aws lambda wait function-active --function-name blueberry-coding-agent
aws lambda update-function-configuration \
  --function-name blueberry-coding-agent \
  --environment file://aws-env.json
```

## 4. Expose a public Function URL

The URL must be public (`auth-type NONE`) so GitHub/Linear can reach it —
authenticity is enforced by the HMAC signature check inside the handler.

```bash
aws lambda create-function-url-config \
  --function-name blueberry-coding-agent \
  --auth-type NONE \
  --query FunctionUrl --output text     # prints e.g. https://abc123.lambda-url.us-east-1.on.aws/

aws lambda add-permission \
  --function-name blueberry-coding-agent \
  --action lambda:InvokeFunctionUrl \
  --principal "*" \
  --function-url-auth-type NONE \
  --statement-id FunctionURLAllowPublicAccess
```

Sanity check (should return `{"ok":true}`):

```bash
curl https://<your-function-url>/health
```

## 5. Point the webhooks at the Function URL

Replace the tunnel URL in both:

- **Linear** webhook → `https://<your-function-url>/webhook/linear`
- **GitHub** (blueberry repo) webhook → `https://<your-function-url>/webhook/github`

Then stop the local `npm run dev` server and the `cloudflared` tunnel.

## Updating after code changes

```bash
npm run package:lambda
aws lambda update-function-code \
  --function-name blueberry-coding-agent --zip-file fileb://lambda.zip
```

If env vars change, re-run `node gen-aws-env.mjs` and the
`update-function-configuration` command from step 3.

## Notes

- **Timeouts**: the handler responds in ~1–3s; GitHub allows 10s, so there's
  ample margin. The 30s Lambda timeout is just a safety cap.
- **No cold-start gap** like Render free — Lambda cold starts are ~sub-second
  with this 170KB bundle, well within webhook timeouts.
- **Secrets** live only in the Lambda's configured environment (and your local
  `.env`/`aws-env.json`, both gitignored). Nothing secret is committed.
