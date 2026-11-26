import "reflect-metadata";

import { Module, type INestApplication, type Type } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AUTH_CONFIG } from "./auth/auth.constants.js";
import { BotModule } from "./bot/bot.module.js";
import { TablesModule } from "./tables/tables.module.js";
import { TicketsModule } from "./tickets/tickets.module.js";

// Retired legacy/public surface. The real controllers of
// each module are mounted with stubbed dependencies, so no database or env is needed.
const BOT_SECRET = "legacy-surface-test-secret-0123456789";
const ID = "4b0d3c1e-8f5a-4c2b-9d7e-1a2b3c4d5e6f";

function constructorTokens(target: Type): unknown[] {
  const injected = (Reflect.getMetadata("self:paramtypes", target) ?? []) as Array<{ index: number; param: unknown }>;
  const declared = (Reflect.getMetadata("design:paramtypes", target) ?? []) as unknown[];
  const tokens = [...declared];
  for (const { index, param } of injected) tokens[index] = param;
  return tokens;
}

function guardClasses(controller: Type): Type[] {
  const found = new Set<Type>();
  const collect = (target: object) => {
    for (const guard of (Reflect.getMetadata("__guards__", target) ?? []) as Type[]) if (typeof guard === "function") found.add(guard);
  };
  collect(controller);
  for (const name of Object.getOwnPropertyNames(controller.prototype)) {
    const method = (controller.prototype as Record<string, unknown>)[name];
    if (typeof method === "function") collect(method);
  }
  return [...found];
}

async function mount(module: Type): Promise<{ app: INestApplication; origin: string }> {
  const controllers = (Reflect.getMetadata("controllers", module) ?? []) as Type[];
  const tokens = new Set<unknown>();
  for (const type of [...controllers, ...controllers.flatMap(guardClasses)]) for (const token of constructorTokens(type)) tokens.add(token);
  tokens.delete(Object);
  const providers = [...tokens].filter((token) => token !== AUTH_CONFIG && (token as { name?: string })?.name !== "Reflector")
    .map((token) => ({ provide: token as string, useValue: {} }));
  @Module({ controllers, providers: [...providers, { provide: AUTH_CONFIG, useValue: { botApiSecret: BOT_SECRET } }] })
  class ProbeModule {}
  const app = await NestFactory.create(ProbeModule, { logger: false });
  await app.listen(0, "127.0.0.1");
  return { app, origin: await app.getUrl() };
}

const probes: Array<{ name: string; module: Type; removed: Array<[string, string]>; kept: [string, string] }> = [
  {
    name: "public table hold/release",
    module: TablesModule,
    removed: [["POST", `/tables/${ID}/hold`], ["POST", `/tables/${ID}/release`]],
    kept: ["GET", `/organizer/tables/${ID}`],
  },
  {
    name: "legacy bot routes and BotActorGuard",
    module: BotModule,
    removed: [
      ["GET", "/bot/events"], ["GET", `/bot/events/${ID}`],
      ["POST", "/bot/quick-session"], ["POST", "/bot/quick-session/message"],
      ["GET", "/bot/tickets"], ["GET", `/bot/tickets/${ID}/qr`],
      ["GET", "/bot/anonymous-tickets"], ["GET", `/bot/anonymous-tickets/${ID}/qr`],
      ["GET", "/bot/organizer/today"], ["GET", `/bot/organizer/events/${ID}/guests`],
    ],
    kept: ["POST", "/bot/identity"],
  },
  {
    name: "non-event-scoped organizer ticket routes",
    module: TicketsModule,
    removed: [
      ["POST", "/organizer/tickets/use"], ["POST", "/organizer/tickets/group-pass/use"],
      ["GET", `/organizer/tickets/${ID}`], ["GET", `/organizer/tickets/${ID}/qr`], ["GET", `/organizer/tickets/${ID}/wallet`],
    ],
    kept: ["POST", `/organizer/tickets/events/${ID}/use`],
  },
];

describe.each(probes)("retired surface: $name", ({ module, removed, kept }) => {
  let app: INestApplication | undefined;
  let origin = "";
  beforeAll(async () => { ({ app, origin } = await mount(module)); });
  afterAll(async () => { await app?.close(); });

  const call = (method: string, path: string) => fetch(`${origin}${path}`, {
    method,
    headers: { "x-bot-api-secret": BOT_SECRET, "content-type": "application/json", authorization: "Bearer bot.e30.sig" },
    ...(method === "GET" ? {} : { body: JSON.stringify({ telegramId: "1", chatId: "1", name: "x", qrToken: "x", token: "x", confirm: true }) }),
  });

  it.each(removed)("%s %s returns 404", async (method, path) => {
    expect((await call(method, path)).status).toBe(404);
  });

  it("still mounts the module's live routes (control)", async () => {
    expect((await call(...kept)).status).not.toBe(404);
  });
});
