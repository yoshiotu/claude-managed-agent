import * as crypto from "crypto";

export interface LinearTicket {
  id: string;
  identifier: string; // e.g. "ENG-42"
  title: string;
  description: string | null;
  url: string;
  teamKey: string;
}

export interface LinearLabel {
  id: string;
  name: string;
}

export interface LinearWebhookPayload {
  action: string;
  type: string;
  data: {
    id: string;
    identifier: string;
    title: string;
    description?: string;
    url: string;
    assignee?: { id: string; name: string };
    team?: { key: string };
    state?: { name: string };
    labelIds?: string[];
    labels?: LinearLabel[];
  };
  // Present on `update` actions; holds the previous values of changed fields only.
  updatedFrom?: {
    labelIds?: string[];
  };
}

export function verifyLinearWebhook(
  rawBody: string,
  signature: string,
  secret: string
): boolean {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

export function isAgentTriggerEvent(
  payload: LinearWebhookPayload,
  labelName: string
): boolean {
  if (payload.type !== "Issue") return false;

  const target = labelName.toLowerCase();
  const label = payload.data.labels?.find(
    (l) => l.name.toLowerCase() === target
  );
  if (!label) return false; // label not currently on the ticket

  // Created already carrying the label → fire once.
  if (payload.action === "create") return true;

  // Updated: only fire on the transition where the label was just added.
  // `updatedFrom.labelIds` is present only when labels actually changed; this
  // prevents re-triggering on unrelated edits to an already-labeled ticket.
  if (payload.action === "update") {
    const previousLabelIds = payload.updatedFrom?.labelIds;
    if (!previousLabelIds) return false; // labels didn't change this update
    return !previousLabelIds.includes(label.id); // newly added
  }

  return false;
}

export function ticketFromPayload(payload: LinearWebhookPayload): LinearTicket {
  return {
    id: payload.data.id,
    identifier: payload.data.identifier,
    title: payload.data.title,
    description: payload.data.description ?? null,
    url: payload.data.url,
    teamKey: payload.data.team?.key ?? "UNKNOWN",
  };
}
