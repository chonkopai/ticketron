import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { resetGeocodeGuards } from "../../../../lib/geocode-guard";
import { POST } from "./route";
const SITE = "https://preview.ticket.example";
const request = (body: unknown, headers: Record<string, string> = { origin: SITE }) => new Request("http://localhost:3000/api/address/geocode", { method: "POST", headers, body: JSON.stringify(body) });
const empty = () => Response.json({ response: { GeoObjectCollection: { featureMember: [] } } });
function configure(t: TestContext) {
  const previous = process.env.YANDEX_GEOCODER_API_KEY;
  const previousOrigin = process.env.WEB_ORIGIN;
  process.env.YANDEX_GEOCODER_API_KEY = "private-test-geocoder-key";
  process.env.WEB_ORIGIN = SITE;
  resetGeocodeGuards(); t.after(resetGeocodeGuards);
  t.after(() => { if (previous === undefined) delete process.env.YANDEX_GEOCODER_API_KEY; else process.env.YANDEX_GEOCODER_API_KEY = previous; });
  t.after(() => { if (previousOrigin === undefined) delete process.env.WEB_ORIGIN; else process.env.WEB_ORIGIN = previousOrigin; });
}
test("reverse lookup swaps SDK coordinates for HTTP order and never returns the key", async t => {
  configure(t);
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    assert.equal(url.origin, "https://geocode-maps.yandex.ru"); assert.equal(url.searchParams.get("geocode"), "76.91,43.25");
    assert.equal(url.searchParams.get("apikey"), "private-test-geocoder-key"); assert.equal(url.searchParams.get("kind"), "house");
    return Response.json({ response: { GeoObjectCollection: { featureMember: [] } } });
  });
  const response = await POST(request({ query: [43.25, 76.91], options: { kind: "house", results: 1 } }));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { places: [] });
});
test("forward lookup preserves text and translates bounds and response language", async t => {
  configure(t);
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    assert.equal(url.searchParams.get("geocode"), "Kazakhstan, Almaty, Abay 10"); assert.equal(url.searchParams.get("lang"), "en_US");
    assert.equal(url.searchParams.get("bbox"), "76,43~77,44"); assert.equal(url.searchParams.get("rspn"), "1");
    return Response.json({ response: { GeoObjectCollection: { featureMember: [] } } });
  });
  assert.equal((await POST(request({ query: "Kazakhstan, Almaty, Abay 10", options: { locale: "en", boundedBy: [[43, 76], [44, 77]], strictBounds: true } }))).status, 200);
});
test("malformed coordinates and excessive result counts never call the provider", async t => {
  configure(t); t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected provider call"); });
  for (const body of [{ query: [100, 76] }, { query: [43, 200] }, { query: "" }, { query: "x", options: { results: 50 } }, { query: "x", options: { boundedBy: [[43, 76]] } }]) assert.equal((await POST(request(body))).status, 400);
});
test("provider errors do not leak credential-bearing URLs or messages", async t => {
  configure(t);
  t.mock.method(globalThis, "fetch", async () => new Response("private-test-geocoder-key", { status: 403 }));
  const response = await POST(request({ query: "Almaty" })); assert.equal(response.status, 502); assert.equal((await response.text()).includes("private-test-geocoder-key"), false);
});
test("HTTP Referer restrictions use the configured website origin instead of a caller's header", async t => {
  configure(t);
  t.mock.method(globalThis, "fetch", async (_url: URL, options: RequestInit) => {
    assert.equal(new Headers(options.headers).get("referer"), "https://preview.ticket.example/");
    return Response.json({ response: { GeoObjectCollection: { featureMember: [] } } });
  });
  const incoming = new Request("http://localhost:3000/api/address/geocode", { method: "POST", headers: { origin: SITE, referer: "https://unrelated.example/" }, body: JSON.stringify({ query: "Almaty" }) });
  assert.equal((await POST(incoming)).status, 200);
});
test("cross-site and header-less callers are refused before the provider is called", async t => {
  configure(t); t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected provider call"); });
  assert.equal((await POST(request({ query: "Almaty" }, { origin: "https://evil.example" }))).status, 403);
  assert.equal((await POST(request({ query: "Almaty" }, {}))).status, 403);
  assert.equal((await POST(request({ query: "Almaty" }, { "sec-fetch-site": "cross-site" }))).status, 403);
});
test("same-origin fetches without an Origin header are accepted", async t => {
  configure(t); t.mock.method(globalThis, "fetch", async () => empty());
  assert.equal((await POST(request({ query: "Almaty" }, { "sec-fetch-site": "same-origin" }))).status, 200);
});
test("queries are capped at 200 characters", async t => {
  configure(t); t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected provider call"); });
  assert.equal((await POST(request({ query: "x".repeat(201) }))).status, 400);
});
test("each client gets its own per-minute budget; forged leading forwarded entries do not reset it", async t => {
  configure(t); t.mock.method(globalThis, "fetch", async () => empty());
  const from = (forwarded: string, index: number) => POST(request({ query: `Street ${index}` }, { origin: SITE, "x-forwarded-for": forwarded }));
  for (let index = 0; index < 60; index++) assert.equal((await from("203.0.113.8", index)).status, 200);
  assert.equal((await from("203.0.113.8", 60)).status, 429);
  assert.equal((await from("198.51.100.1, 203.0.113.8", 61)).status, 429);
  assert.equal((await from("203.0.113.9", 62)).status, 200);
});
test("identical queries are served from a short cache", async t => {
  configure(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => empty());
  for (let index = 0; index < 3; index++) assert.equal((await POST(request({ query: "Almaty, Abay 10" }))).status, 200);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(await (await POST(request({ query: "Almaty, Abay 10" }))).json(), { places: [] });
});
