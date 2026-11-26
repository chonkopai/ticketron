import { describe, expect, it, vi } from "vitest";

import { handleTelegramWebhook, type WebhookDeps } from "./webhook-handler.js";

const secret = "s".repeat(32);
const raw = Buffer.from('{"update_id":7,"message":{}}');

function deps(claim: { process?: boolean; retry?: boolean }, handleUpdate: WebhookDeps["handleUpdate"]) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetchStub = vi.fn(async (url: URL | string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify(path.endsWith("/claim") ? claim : {}), { status: 200, headers: { "content-type": "application/json" } });
  });
  const logError = vi.fn();
  return { calls, logError, value: { webhookSecret: secret, botApiSecret: "b".repeat(32), apiBaseUrl: "http://api.test", botId: "1", fetch: fetchStub as unknown as typeof fetch, handleUpdate, logError } satisfies WebhookDeps };
}

describe("Telegram webhook acknowledgement", () => {
  it("answers 200 right after the claim while a slow handler is still running, then completes the inbox row", async () => {
    let finish!: () => void;
    const handleUpdate = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const d = deps({ process: true }, handleUpdate);
    const result = await handleTelegramWebhook(secret, raw, d.value);
    expect(result.status).toBe(200);
    expect(handleUpdate).toHaveBeenCalledTimes(1);
    expect(d.calls.map((call) => call.path)).toEqual(["/bot/updates/claim"]);
    finish();
    await result.processing;
    expect(d.calls.at(-1)).toMatchObject({ path: "/bot/updates/complete", body: { updateId: "7", failed: false } });
  });

  it("records a failed run without asking Telegram to redeliver it", async () => {
    const d = deps({ process: true }, async () => { throw new Error("handler failed for guest@example.test"); });
    const result = await handleTelegramWebhook(secret, raw, d.value);
    expect(result.status).toBe(200);
    await result.processing;
    expect(d.calls.at(-1)).toMatchObject({ path: "/bot/updates/complete", body: { failed: true } });
    expect(JSON.stringify(d.logError.mock.calls)).not.toContain("@example.test");
  });

  it("drops a duplicate delivery without running the handler", async () => {
    const handleUpdate = vi.fn(async () => undefined);
    const d = deps({ process: false }, handleUpdate);
    expect(await handleTelegramWebhook(secret, raw, d.value)).toMatchObject({ status: 200, body: { duplicate: true } });
    expect(handleUpdate).not.toHaveBeenCalled();
  });

  it("asks Telegram to retry only when the update was not claimed", async () => {
    const handleUpdate = vi.fn(async () => undefined);
    const d = deps({ process: false }, handleUpdate);
    d.value.fetch = vi.fn(async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    expect((await handleTelegramWebhook(secret, raw, d.value)).status).toBe(503);
    expect((await handleTelegramWebhook("wrong", raw, d.value)).status).toBe(401);
    expect(handleUpdate).not.toHaveBeenCalled();
  });
});
