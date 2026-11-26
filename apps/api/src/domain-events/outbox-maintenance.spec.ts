import "../test-support/require-test-database.js";
import { randomUUID } from "node:crypto";

import { prisma } from "@event-platform/database";
import { afterAll, describe, expect, it } from "vitest";

import { maintainOutbox, OUTBOX_RETENTION_MS } from "./outbox-maintenance.js";

const aggregateId = randomUUID();
afterAll(async () => {
  await prisma.outboxEvent.deleteMany({ where: { aggregateId } });
  await prisma.$disconnect();
});

describe("outbox maintenance", () => {
  it("marks types without a consumer processed, prunes old processed rows and keeps facts and pending work", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - OUTBOX_RETENTION_MS - 60_000);
    const row = (eventType: string, processedAt: Date | null) => prisma.outboxEvent.create({ data: { eventType, aggregateType: "order", aggregateId, payload: {}, occurredAt: processedAt ?? now, processedAt } });
    const unconsumed = await row("ticket_inventory.reserved", null);
    const consumedPending = await row("checkout.paid", null);
    const emailPending = await row("ticket.email_requested", null);
    const oldNoise = await row("table.hold_created", old);
    const oldFact = await row("payment.review_required", old);
    const oldHistory = await row("payment.succeeded", old);
    const recentNoise = await row("checkout.ticket_created", now);

    await maintainOutbox(prisma, now);
    const state = async (id: string) => prisma.outboxEvent.findUnique({ where: { id } });

    expect((await state(unconsumed.id))?.processedAt).not.toBeNull();
    expect((await state(consumedPending.id))?.processedAt).toBeNull();
    expect((await state(emailPending.id))?.processedAt).toBeNull();
    expect(await state(oldNoise.id)).toBeNull();
    expect(await state(oldFact.id)).not.toBeNull();
    expect(await state(oldHistory.id)).not.toBeNull();
    expect(await state(recentNoise.id)).not.toBeNull();
  });
});
