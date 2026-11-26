import "reflect-metadata";
import type { AddressInfo } from "node:net";
import { Controller, Module, Param, Patch, Post, Req } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BODY_PARSER_APP_OPTIONS, configureBodyParsers } from "./http-body.js";

type Parsed = { body?: unknown; rawBody?: Buffer };
const echo = (req: Parsed) => ({ parsed: typeof req.body === "object" && req.body !== null && "data" in req.body, raw: Buffer.isBuffer(req.rawBody) });

@Controller()
class EchoController {
  @Post("auth/password/login") login(@Req() req: Parsed) { return echo(req); }
  @Patch("creation-drafts/:id") draft(@Param("id") _id: string, @Req() req: Parsed) { return echo(req); }
  @Post("organizer/events/:id/venue-layout") layout(@Param("id") _id: string, @Req() req: Parsed) { return echo(req); }
  @Post("payments/webhooks/:provider") webhook(@Param("provider") _provider: string, @Req() req: Parsed) { return echo(req); }
}
@Module({ controllers: [EchoController] })
class EchoModule {}

describe("scoped JSON body limits (§12 #30)", () => {
  let app: NestExpressApplication;
  let base: string;
  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(EchoModule, { ...BODY_PARSER_APP_OPTIONS, logger: false });
    configureBodyParsers(app);
    await app.listen(0, "127.0.0.1");
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => { await app?.close(); });

  const send = (method: string, path: string, bytes: number) =>
    fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ data: "x".repeat(bytes) }) });

  it("keeps the 100 KB default on ordinary routes", async () => {
    expect((await send("POST", "/auth/password/login", 1_000)).status).toBe(201);
    expect((await send("POST", "/auth/password/login", 200_000)).status).toBe(413);
  });

  it("allows 4 MB hall-editor documents", async () => {
    expect((await send("PATCH", "/creation-drafts/00000000-0000-4000-8000-000000000001", 2_000_000)).status).toBe(200);
    expect((await send("POST", "/organizer/events/00000000-0000-4000-8000-000000000001/venue-layout", 2_000_000)).status).toBe(201);
    expect((await send("PATCH", "/creation-drafts/00000000-0000-4000-8000-000000000001", 5_000_000)).status).toBe(413);
  });

  it("keeps a raw body copy only for provider webhooks", async () => {
    expect(await (await send("POST", "/payments/webhooks/mock", 100)).json()).toEqual({ parsed: true, raw: true });
    expect(await (await send("POST", "/auth/password/login", 100)).json()).toEqual({ parsed: true, raw: false });
  });
});
