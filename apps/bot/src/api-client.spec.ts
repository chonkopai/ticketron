import { describe, expect, it, vi } from "vitest";

import { BotApiClient } from "./api-client.js";

describe("BotApiClient", () => {
  it("sends only the bot secret header (no bot identity token)", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new BotApiClient({ apiBaseUrl: "http://localhost:3001", botApiSecret: "s".repeat(32), fetch: request });
    await client.catalogue({ locale: "en", page: 1 });
    expect(request).toHaveBeenCalledOnce();
    expect(String(request.mock.calls[0]?.[0])).toContain("limit=6");
    expect(request.mock.calls[0]?.[1]?.headers).toEqual({ "x-bot-api-secret": "s".repeat(32) });
  });

  it("URL-encodes event search queries", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    const client = new BotApiClient({ apiBaseUrl: "http://localhost:3001", botApiSecret: "s".repeat(32), fetch: request });
    await client.catalogue({ locale: "en", page: 1, search: "джаз Алматы" });
    expect(String(request.mock.calls[0]?.[0])).toContain("search=%D0%B4%D0%B6%D0%B0%D0%B7+%D0%90%D0%BB%D0%BC%D0%B0%D1%82%D1%8B");
  });
});
