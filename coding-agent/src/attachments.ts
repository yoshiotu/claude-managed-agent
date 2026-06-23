import type { LinearTicket } from "./linear.js";

export interface FetchedAttachment {
  filename: string;
  data: Buffer;
}

const UPLOAD_URL_RE = /https:\/\/uploads\.linear\.app\/[^\s)"'>]+/g;
const MARKDOWN_LINK_RE =
  /\[([^\]]+)\]\((https:\/\/uploads\.linear\.app\/[^)]+)\)/g;

const MAX_FILES = 20;
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB per file

async function linearGraphQL(
  token: string,
  query: string,
  variables: Record<string, unknown>
): Promise<any> {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: any; errors?: unknown };
  if (json.errors) throw new Error(`Linear GraphQL: ${JSON.stringify(json.errors)}`);
  return json.data;
}

/** Map each uploads.linear.app URL to its markdown link text (a filename hint). */
function linkTextByUrl(markdown: string): Map<string, string> {
  const map = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = MARKDOWN_LINK_RE.exec(markdown))) map.set(m[2], m[1]);
  return map;
}

/** Pick a safe filename: Content-Disposition wins, then the markdown link text. */
function filenameFor(res: Response, linkText: string | undefined): string {
  const disp = res.headers.get("content-disposition") ?? "";
  const m = disp.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  const raw = (m?.[1] && decodeURIComponent(m[1])) || linkText || "attachment";
  const safe = raw.replace(/[/\\]/g, "_").replace(/[^\w.\- ]/g, "").trim();
  return safe || "attachment";
}

/**
 * Download the files uploaded to a Linear ticket (embedded in the description or
 * listed in the attachments relation). Uses the Linear API token directly — this
 * runs in the webhook receiver, so the token never reaches the agent sandbox.
 */
export async function fetchTicketAttachments(
  ticket: LinearTicket,
  token: string
): Promise<FetchedAttachment[]> {
  const data = await linearGraphQL(
    token,
    `query($id: String!) {
      issue(id: $id) {
        description
        attachments { nodes { url } }
      }
    }`,
    { id: ticket.id }
  );
  const issue = data?.issue;
  if (!issue) return [];

  const description: string = issue.description ?? "";
  const hints = linkTextByUrl(description);

  // Unique uploaded-file URLs from the description and the attachments relation.
  const urls = new Set<string>();
  for (const u of description.match(UPLOAD_URL_RE) ?? []) urls.add(u);
  for (const a of issue.attachments?.nodes ?? []) {
    if (typeof a.url === "string" && a.url.includes("uploads.linear.app")) urls.add(a.url);
  }

  const out: FetchedAttachment[] = [];
  for (const url of [...urls].slice(0, MAX_FILES)) {
    try {
      const res = await fetch(url, { headers: { Authorization: token } });
      if (!res.ok) {
        console.warn(`[${ticket.identifier}] attachment download failed (${res.status}): ${url}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES) {
        console.warn(`[${ticket.identifier}] attachment too large (${buf.length}b), skipping`);
        continue;
      }
      out.push({ filename: filenameFor(res, hints.get(url)), data: buf });
    } catch (err) {
      console.warn(`[${ticket.identifier}] attachment error for ${url}: ${(err as Error).message}`);
    }
  }
  return out;
}
