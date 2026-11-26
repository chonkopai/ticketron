import { createHash } from "node:crypto";

import { parseTelegramUpdate, verifyTelegramWebhookSecret } from "./webhook.js";

export interface WebhookDeps {
  webhookSecret: string;
  botApiSecret: string;
  apiBaseUrl: string;
  botId: string;
  fetch: typeof fetch;
  /** Runs the bot's middleware for one update (grammY `bot.handleUpdate`). */
  handleUpdate: (update: { update_id: number }) => Promise<unknown>;
  logError: (message: string) => void;
}

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
  /** Present when the update was claimed: the handler run plus its inbox completion. */
  processing?: Promise<void>;
}

/**
 * Telegram is answered as soon as the inbox claim succeeds; the update is then handled
 * in the background. A slow handler can no longer trip a webhook timeout, so Telegram
 * does not redeliver an update that is still running, and a failed run is recorded
 * without making Telegram replay replies that were already sent.
 */
export async function handleTelegramWebhook(provided: string | undefined, raw: Buffer, deps: WebhookDeps): Promise<WebhookResult> {
  if (!verifyTelegramWebhookSecret(provided, deps.webhookSecret)) return { status: 401, body: { code: "TELEGRAM_WEBHOOK_UNAUTHORIZED" } };
  const update = parseTelegramUpdate(raw);
  if (!update) return { status: 400, body: { code: "TELEGRAM_UPDATE_INVALID" } };
  const payloadHash = createHash("sha256").update(raw).digest("hex");
  const headers = { "content-type": "application/json", "x-bot-api-secret": deps.botApiSecret };
  const identity = { botId: deps.botId, updateId: String(update.update_id), payloadHash };
  let claim: { process?: boolean; retry?: boolean };
  try {
    const response = await deps.fetch(new URL("/bot/updates/claim", deps.apiBaseUrl), { method: "POST", headers, body: JSON.stringify(identity) });
    if (!response.ok) return { status: 503, body: { code: "TELEGRAM_INBOX_UNAVAILABLE" } };
    claim = await response.json() as { process?: boolean; retry?: boolean };
  } catch {
    // Not claimed: Telegram may safely redeliver.
    return { status: 503, body: { code: "TELEGRAM_INBOX_UNAVAILABLE" } };
  }
  if (claim.retry === true) return { status: 503, body: { code: "TELEGRAM_UPDATE_IN_PROGRESS" } };
  if (claim.process !== true) return { status: 200, body: { ok: true, duplicate: true } };
  const processing = (async () => {
    let failed = false;
    try { await deps.handleUpdate(update); }
    catch { failed = true; deps.logError(`Telegram update ${update.update_id} failed`); }
    try {
      const complete = await deps.fetch(new URL("/bot/updates/complete", deps.apiBaseUrl), { method: "POST", headers, body: JSON.stringify({ ...identity, failed }) });
      if (!complete.ok) deps.logError("Telegram inbox completion failed");
    } catch { deps.logError("Telegram inbox completion failed"); }
  })();
  return { status: 200, body: { ok: true }, processing };
}
