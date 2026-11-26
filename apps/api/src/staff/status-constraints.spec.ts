import "../test-support/require-test-database.js";
import { randomUUID } from "node:crypto";

import { prisma } from "@event-platform/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Every value the code writes, per column. A new value needs a new migration.
const MODERATION = ["clear", "pending", "approved", "sales_paused", "rejected", "hidden", "cancelled", "expired"];
const EMAIL = ["queued", "sending", "accepted", "failed", "uncertain"];
const OPERATION = ["pending", "dispatching", "queued", "failed", "completed"];
const REFUND = ["requested", "processing", "succeeded", "failed"];
const BAD = ["aproved", "Approved", "", "x".repeat(20)];

const staffId = randomUUID(), organizerId = randomUUID(), eventId = randomUUID(), orderId = randomUUID(), paymentId = randomUUID();
let refundId = "", emailId = "";

beforeAll(async () => {
  await prisma.staffAccount.create({ data: { id: staffId, name: "Status check", email: `${staffId}@example.test`, role: "moderator" } });
  await prisma.user.create({ data: { id: organizerId, role: "organizer", name: "Status check" } });
  await prisma.event.create({ data: { id: eventId, organizerId, title: "Status check", address: "x", date: new Date("2031-12-01"), time: new Date("1970-01-01T12:00:00Z") } });
  await prisma.order.create({ data: { id: orderId, type: "ticket", amount: 100, currency: "KZT", paymentStatus: "paid" } });
  await prisma.payment.create({ data: { id: paymentId, orderId, provider: "stripe", providerPaymentId: `pp-${paymentId}`, providerRequestKey: `rk-${paymentId}`, amount: 100, currency: "KZT", status: "paid" } });
  emailId = (await prisma.ticketEmailDelivery.create({ data: { orderId, recipient: "status@example.test", capabilityHash: randomUUID(), capabilityExpiresAt: new Date(Date.now() + 3_600_000) } })).id;
  refundId = (await prisma.staffRefund.create({ data: { staffId, orderId, paymentId, requestKey: randomUUID(), amount: 100, currency: "KZT", reason: "x", provider: "stripe" } })).id;
});

afterAll(async () => {
  await prisma.staffOperation.deleteMany({ where: { staffId } });
  await prisma.staffRefund.deleteMany({ where: { staffId } });
  await prisma.ticketEmailDelivery.deleteMany({ where: { orderId } });
  await prisma.payment.deleteMany({ where: { orderId } });
  await prisma.order.deleteMany({ where: { id: orderId } });
  await prisma.event.deleteMany({ where: { id: eventId } });
  await prisma.user.deleteMany({ where: { id: organizerId } });
  await prisma.staffAccount.deleteMany({ where: { id: staffId } });
});

describe("status columns reject unknown values", () => {
  it("keeps the column defaults valid", async () => {
    expect(await prisma.event.findUniqueOrThrow({ where: { id: eventId } })).toMatchObject({ moderationStatus: "clear" });
    expect(await prisma.ticketEmailDelivery.findUniqueOrThrow({ where: { id: emailId } })).toMatchObject({ status: "queued" });
    expect(await prisma.staffRefund.findUniqueOrThrow({ where: { id: refundId } })).toMatchObject({ status: "requested" });
  });

  it("Event.moderationStatus", async () => {
    for (const moderationStatus of MODERATION) {
      await prisma.event.update({ where: { id: eventId }, data: { moderationStatus } });
      const created = await prisma.event.create({ data: { organizerId, title: "Status check", address: "x", date: new Date("2031-12-01"), time: new Date("1970-01-01T12:00:00Z"), moderationStatus } });
      await prisma.event.delete({ where: { id: created.id } });
    }
    for (const moderationStatus of BAD) {
      await expect(prisma.event.update({ where: { id: eventId }, data: { moderationStatus } })).rejects.toThrow();
      await expect(prisma.event.create({ data: { organizerId, title: "Status check", address: "x", date: new Date("2031-12-01"), time: new Date("1970-01-01T12:00:00Z"), moderationStatus } })).rejects.toThrow();
    }
  });

  it("TicketEmailDelivery.status", async () => {
    for (const status of EMAIL) await prisma.ticketEmailDelivery.update({ where: { id: emailId }, data: { status } });
    for (const status of BAD) await expect(prisma.ticketEmailDelivery.update({ where: { id: emailId }, data: { status } })).rejects.toThrow();
  });

  it("StaffOperation.status", async () => {
    const data = (status?: string) => ({ staffId, key: randomUUID(), kind: "resend", resourceId: orderId, requestHash: "x", ...(status === undefined ? {} : { status }) });
    await prisma.staffOperation.create({ data: data() });
    for (const status of OPERATION) await prisma.staffOperation.create({ data: data(status) });
    for (const status of BAD) await expect(prisma.staffOperation.create({ data: data(status) })).rejects.toThrow();
    const row = await prisma.staffOperation.create({ data: data() });
    await expect(prisma.staffOperation.update({ where: { id: row.id }, data: { status: "dispatchng" } })).rejects.toThrow();
  });

  it("StaffRefund.status", async () => {
    for (const status of REFUND) await prisma.staffRefund.update({ where: { id: refundId }, data: { status } });
    for (const status of BAD) await expect(prisma.staffRefund.update({ where: { id: refundId }, data: { status } })).rejects.toThrow();
  });
});
