import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { newEventCreationDraft, wrapRichDescription } from "@event-platform/shared-types";
import { LocaleProvider } from "../components/locale-provider";
import { CurrencyProvider } from "../components/currency-provider";
import PublicEventPage from "../app/events/[id]/event-client";
import { draftEventPreview } from "./draft-event-preview";

// Server rendering (metadata and the first payload) must call the API's
// internal origin, never NEXT_PUBLIC_API_URL (the web origin, where /events/<id>
// is the page itself).
test("server reads of a public event go to API_INTERNAL_URL with the request locale", async () => {
  process.env.API_INTERNAL_URL = "http://api.internal:3001";
  process.env.NEXT_PUBLIC_API_URL = "https://site.example";
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return String(input).includes("missing") ? new Response("<html>", { status: 404 }) : Response.json({ id: "event-1", title: "Concert" });
  }) as typeof fetch;
  try {
    const { fetchServerPublicEvent, fetchServerPublicEvents } = await import("./server-public-api");
    assert.deepEqual(await fetchServerPublicEvent("event-1", "kk"), { id: "event-1", title: "Concert" });
    assert.equal(await fetchServerPublicEvent("missing", "ru"), null);
    await fetchServerPublicEvents({ sort: "soonest", includeRemaining: true, page: 2, limit: 18, city: "Алматы" }, "en");
    assert.equal(calls[0], "http://api.internal:3001/events/event-1?locale=kk");
    assert.ok(calls.every(url => url.startsWith("http://api.internal:3001/events")), calls.join("\n"));
    assert.match(calls[2]!, /locale=en&page=2&limit=18&sort=soonest&includeRemaining=true&city=/);
  } finally {
    globalThis.fetch = original;
  }
});

// The public event client must not bundle sanitize-html; the server
// passes the sanitized description in, and the client fallback renders text only.
test("the public event client never imports the HTML sanitizer", () => {
  const file = ["src/app/events/[id]/event-client.tsx", "apps/web/src/app/events/[id]/event-client.tsx"].map(path => join(process.cwd(), path)).find(existsSync);
  assert.ok(file, "event-client.tsx not found from the test working directory");
  const source = readFileSync(file, "utf8");
  assert.doesNotMatch(source, /event-description"|rich-description"|sanitize-html/);
});

test("without a server-sanitized description the client renders the description as inert text", () => {
  const draft = newEventCreationDraft("10000000-0000-4000-8000-000000000002", "ru");
  draft.schedule = { startLocal: "2031-12-01T20:00", endLocal: "2031-12-01T23:00", timezone: "Asia/Almaty", startChoice: null, endChoice: null };
  draft.selectedMode = "free";
  draft.content.ru = { title: "Концерт", description: "Описание", address: "Адрес" };
  draft.free.content.ru = { name: "Приглашение" };
  const model = draftEventPreview("10000000-0000-4000-8000-000000000002", draft, "ru", [], { title: "Title", address: "Address", invitation: "Invite" });
  const event = { ...model.event, creationVersion: 2 as const, description: wrapRichDescription("<p><strong>Rich</strong></p><img src=x onerror=alert(1)>") };
  const render = (description?: React.ReactNode) => renderToStaticMarkup(<LocaleProvider locale="ru"><CurrencyProvider><PublicEventPage id={event.id} description={description} preview={{ ...model, event, interactive: true, descriptionPlaceholder: "", emptyTickets: "", showRefund: true }} /></CurrencyProvider></LocaleProvider>);
  const fallback = render();
  assert.doesNotMatch(fallback, /<img src="x"|onerror|<strong>Rich/);
  assert.match(fallback, />Rich</);
  assert.match(render(<div className="server-sanitized"><strong>Rich</strong></div>), /class="server-sanitized"><strong>Rich<\/strong>/);
});
