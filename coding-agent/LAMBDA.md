# Deploying the webhook receiver to AWS Lambda

The webhook receiver runs as a single Lambda behind an **API Gateway HTTP API**
(HTTPS, always-on, no servers to manage). It verifies the webhook signature, creates a
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

## 4. Expose it via an API Gateway HTTP API

A public HTTPS front door so GitHub/Linear can reach the function; authenticity
is enforced by the HMAC signature check inside the handler. The handler reads
API Gateway's v2.0 event format (same shape as a Lambda Function URL), so no
code changes are needed.

> **Why not a Lambda Function URL?** A Function URL is simpler, but some AWS
> accounts reject public (`auth-type NONE`) Function URLs at the auth layer
> regardless of a correct resource policy — you get `Forbidden` even though
> direct `aws lambda invoke` works. API Gateway uses a different ingress path
> and is not affected, so it's the reliable choice.

```bash
REGION=us-west-1
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
FN_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:blueberry-coding-agent"

# Create an HTTP API wired to the Lambda (quick-create: catch-all route + auto-deploy stage)
API_ID=$(aws apigatewayv2 create-api \
  --name blueberry-coding-agent-api \
  --protocol-type HTTP \
  --target "$FN_ARN" \
  --region "$REGION" \
  --query ApiId --output text)

# Allow API Gateway to invoke the Lambda (quick-create usually adds this; harmless if duplicate)
aws lambda add-permission \
  --function-name blueberry-coding-agent --region "$REGION" \
  --statement-id apigw-invoke \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${API_ID}/*/*" 2>/dev/null || true

# Print the endpoint and sanity-check it
ENDPOINT=$(aws apigatewayv2 get-api --api-id "$API_ID" --region "$REGION" --query ApiEndpoint --output text)
echo "Endpoint: $ENDPOINT"
curl "${ENDPOINT}/health"    # -> {"ok":true}
```

## 5. Point the webhooks at the endpoint

Replace the tunnel URL in both:

- **Linear** webhook → `<endpoint>/webhook/linear`
- **GitHub** (blueberry repo) webhook → `<endpoint>/webhook/github`

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
