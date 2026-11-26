import "../test-support/require-test-database.js";
import { randomUUID } from "node:crypto";

import { prisma } from "@event-platform/database";
import { afterAll, describe, expect, it } from "vitest";

import { StaffManagementService } from "./staff-management.service.js";

const service = new StaffManagementService(prisma, {} as never, {} as never, {} as never);
const aggregateId = randomUUID();
const orderIds: string[] = [];

afterAll(async () => {
  await prisma.ticketEmailDelivery.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.outboxEvent.deleteMany({ where: { aggregateId } });
  await prisma.$disconnect();
});

describe("staff issues queue counts", () => {
  it("counts pending and dead outbox rows and the non-terminal ticket email backlog", async () => {
    const before = (await service.issues()).queues;
    const outbox = (data: { attempts?: number; deadAt?: Date; processedAt?: Date }) => ({ eventType: "queue.metrics.test", aggregateType: "test", aggregateId, payload: {}, ...data });
    await prisma.outboxEvent.createMany({ data: [outbox({}), outbox({ attempts: 5, deadAt: new Date() }), outbox({ processedAt: new Date() })] });
    for (const status of ["queued", "sending", "accepted", "failed", "uncertain"]) {
      const id = randomUUID();
      orderIds.push(id);
      await prisma.order.create({ data: { id, type: "ticket", amount: 1000, currency: "KZT", paymentStatus: "paid" } });
      await prisma.ticketEmailDelivery.create({ data: { orderId: id, recipient: `${id}@example.test`, status, capabilityHash: id, capabilityExpiresAt: new Date(Date.now() + 60_000) } });
    }
    const after = (await service.issues()).queues;
    expect(after.outboxPending - before.outboxPending).toBe(1);
    expect(after.outboxDead - before.outboxDead).toBe(1);
    expect(after.ticketEmailBacklog - before.ticketEmailBacklog).toBe(2);
  });
});
