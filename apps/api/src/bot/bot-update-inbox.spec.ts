import "../test-support/require-test-database.js";
import { createHash, randomUUID } from "node:crypto";

import { prisma } from "@event-platform/database";
import { afterAll, describe, expect, it } from "vitest";

import { BotService } from "./bot.service.js";

const botId = `test-${randomUUID()}`;
const service = new BotService(prisma);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

afterAll(async () => {
  await prisma.telegramUpdate.deleteMany({ where: { botId } });
  await prisma.$disconnect();
});

describe("Telegram update inbox claims", () => {
  it("drops a redelivery while the first run still owns the lease", async () => {
    const payload = hash("update-1");
    expect(await service.claimUpdate(botId, "1", payload)).toEqual({ process: true });
    expect(await service.claimUpdate(botId, "1", payload)).toEqual({ process: false });
    await service.completeUpdate(botId, "1", payload);
    expect(await service.claimUpdate(botId, "1", payload)).toEqual({ process: false });
  });

  it("lets exactly one of several concurrent deliveries process an update", async () => {
    const payload = hash("update-2");
    const claims = await Promise.all(Array.from({ length: 8 }, () => service.claimUpdate(botId, "2", payload)));
    expect(claims.filter((claim) => claim.process)).toHaveLength(1);
  });

  it("lets exactly one concurrent delivery re-claim a failed update", async () => {
    const payload = hash("update-3");
    await service.claimUpdate(botId, "3", payload);
    await service.completeUpdate(botId, "3", payload, true);
    const claims = await Promise.all(Array.from({ length: 8 }, () => service.claimUpdate(botId, "3", payload)));
    expect(claims.filter((claim) => claim.process)).toHaveLength(1);
  });

  it("keeps a lease longer than a slow handler run", async () => {
    const payload = hash("update-4");
    await service.claimUpdate(botId, "4", payload);
    const row = await prisma.telegramUpdate.findFirstOrThrow({ where: { botId, updateId: 4n } });
    expect(row.leaseUntil!.getTime() - Date.now()).toBeGreaterThan(10 * 60_000);
  });
});

describe("Telegram update pruning", () => {
  it("removes old finished updates and keeps processing and recent ones", async () => {
    const pruneBot = `prune-${randomUUID()}`;
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const row = (updateId: number, status: "processing" | "completed" | "failed", createdAt: Date) =>
      ({ botId: pruneBot, updateId: BigInt(updateId), payloadHash: hash(String(updateId)), status, createdAt });
    try {
      await prisma.telegramUpdate.createMany({ data: [
        row(1, "completed", old), row(2, "failed", old), row(3, "processing", old),
        row(4, "completed", new Date()),
      ] });
      await service.pruneUpdates();
      const left = await prisma.telegramUpdate.findMany({ where: { botId: pruneBot }, orderBy: { updateId: "asc" } });
      expect(left.map((r) => Number(r.updateId))).toEqual([3, 4]);
    } finally {
      await prisma.telegramUpdate.deleteMany({ where: { botId: pruneBot } });
    }
  });
});
