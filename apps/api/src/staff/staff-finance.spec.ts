import "../test-support/require-test-database.js";
import { createPrismaClient } from "@event-platform/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { financeFacts } from "./staff-finance.js";

const database = createPrismaClient({ log: [{ emit: "event", level: "query" }] });
let queries = 0;
(database as unknown as { $on(event: "query", listener: () => void): void }).$on("query", () => { queries += 1; });

const uuid = (group: number, index: number) => `00000000-0000-4000-8${group.toString().padStart(3, "0")}-${(index + 0xf1000).toString(16).padStart(12, "0")}`;
const orgA = uuid(1, 1), orgB = uuid(1, 2), staffId = uuid(1, 3);
const eventA = uuid(2, 1), eventB = uuid(2, 2);
const typeA = uuid(3, 1), typeB = uuid(3, 2);
const t = (iso: string) => new Date(iso);
const orderIds: string[] = [];
let seq = 100;

async function sale(opts: { event: "A" | "B" | "snapshotA" | "none"; amount: number; commission: number | null; provider?: string; status?: "paid" | "refunded"; settled?: string | null; orderAmount?: number }) {
  const n = seq++;
  const orderId = uuid(4, n), paymentId = uuid(5, n);
  orderIds.push(orderId);
  await database.order.create({ data: {
    id: orderId, type: "ticket", amount: opts.orderAmount ?? opts.amount, currency: "KZT", paymentStatus: "paid",
    commissionAmount: opts.commission,
    ...(opts.event === "snapshotA" ? { checkoutSnapshot: { eventId: eventA } } : {}),
  } });
  if (opts.event === "A" || opts.event === "B")
    await database.ticket.create({ data: { orderId, ticketTypeId: opts.event === "A" ? typeA : typeB, qrToken: `fin-${n}`, status: "active" } });
  await database.payment.create({ data: {
    id: paymentId, orderId, provider: opts.provider ?? "stripe", providerPaymentId: `pp-${n}`, providerRequestKey: `rk-${n}`,
    amount: opts.amount, currency: "KZT", status: opts.status ?? "paid",
    webhookReceivedAt: opts.settled === null ? null : t(opts.settled ?? "2027-01-10T10:00:00.000Z"),
  } });
  return { orderId, paymentId };
}
const refund = (paymentId: string, orderId: string, n: number, amount: number, completedAt: string | null) =>
  database.staffRefund.create({ data: { id: uuid(6, n), staffId, orderId, paymentId, requestKey: uuid(7, n), amount, currency: "KZT", reason: "x", provider: "stripe", status: "succeeded", completedAt: completedAt ? t(completedAt) : null } });

beforeAll(async () => {
  await cleanup();
  await database.staffAccount.create({ data: { id: staffId, name: "Finance test", email: `${staffId}@example.test`, role: "moderator" } });
  await database.user.createMany({ data: [
    { id: orgA, role: "organizer", name: "Org A" },
    { id: orgB, role: "organizer", name: "Org B" },
  ] });
  const base = { organizerId: orgA, title: "Fin", status: "published" as const, approvedAt: t("2027-01-01T00:00:00.000Z"), moderationStatus: "approved", publishedAt: t("2027-01-01T00:00:00.000Z"), address: "x", date: t("2027-02-01T00:00:00.000Z"), time: t("1970-01-01T18:00:00.000Z") };
  await database.event.createMany({ data: [{ id: eventA, ...base }, { id: eventB, ...base, organizerId: orgB }] });
  await database.ticketType.createMany({ data: [
    { id: typeA, eventId: eventA, name: "A", price: 100, currency: "KZT", quantityTotal: 99 },
    { id: typeB, eventId: eventB, name: "B", price: 100, currency: "KZT", quantityTotal: 99 },
  ] });
  await database.event.updateMany({ where: { id: { in: [eventA, eventB] } }, data: { approvedAt: t("2027-01-01T00:00:00.000Z"), moderationStatus: "approved" } });
  const a1 = await sale({ event: "A", amount: 10_000, commission: 1_000 });
  await refund(a1.paymentId, a1.orderId, 1, 3_000, "2027-01-12T10:00:00.000Z");
  await refund(a1.paymentId, a1.orderId, 2, 2_000, "2027-01-11T10:00:00.000Z");
  const a2 = await sale({ event: "snapshotA", amount: 5_000, commission: 333, settled: "2027-01-09T10:00:00.000Z" });
  await database.refundRequest.create({ data: { id: uuid(8, 1), orderId: a2.orderId, paymentId: a2.paymentId, organizerId: orgA, provider: "stripe", requestKey: "fin-legacy", amount: 1_000, currency: "KZT", reason: "x", status: "succeeded" } });
  await sale({ event: "A", amount: 7_000, commission: null, status: "refunded" });
  const b1 = await sale({ event: "B", amount: 20_000, commission: 2_000 });
  await refund(b1.paymentId, b1.orderId, 3, 20_000, "2027-01-15T10:00:00.000Z");
  await sale({ event: "B", amount: 4_000, commission: 400, settled: null });
  await sale({ event: "B", amount: 6_000, commission: 600, orderAmount: 6_500 });
  await database.organizerPayout.create({ data: { organizerId: orgA, currency: "KZT", amount: 4_000, paidAt: t("2027-01-13T00:00:00.000Z"), testOnly: false, staffId, reference: "fin-payout", requestKey: uuid(7, 90) } });
});

async function cleanup() {
  await database.staffRefund.deleteMany({ where: { staffId } });
  await database.refundRequest.deleteMany({ where: { organizerId: orgA } });
  await database.order.deleteMany({ where: { id: { in: Array.from({ length: 60 }, (_, i) => uuid(4, 100 + i)) } } });
  await database.organizerPayout.deleteMany({ where: { organizerId: { in: [orgA, orgB] } } });
  await database.event.deleteMany({ where: { id: { in: [eventA, eventB] } } });
  await database.staffAccount.deleteMany({ where: { id: staffId } });
  await database.user.deleteMany({ where: { id: { in: [orgA, orgB] } } });
}

afterAll(async () => {
  await cleanup();
  await database.$disconnect();
});

describe("financeFacts", () => {
  it("returns the full ledger for each organizer", async () => {
    const a = await financeFacts(database, { organizerId: orgA });
    const b = await financeFacts(database, { organizerId: orgB });
    expect({ a, b }).toMatchSnapshot();
  });

  it("applies the event filter and period windows", async () => {
    const byEvent = await financeFacts(database, { organizerId: orgB, eventId: eventB });
    const period = await financeFacts(database, { organizerId: orgA, from: "2027-01-11", to: "2027-01-12T23:59:59Z" });
    expect({ byEvent, period }).toMatchSnapshot();
  });

  it("keeps the query count independent of the number of payments", async () => {
    await financeFacts(database, { organizerId: orgB });
    queries = 0;
    await financeFacts(database, { organizerId: orgB });
    const before = queries;
    for (let i = 0; i < 6; i++) {
      const s = await sale({ event: i % 2 ? "B" : "snapshotA", amount: 1_000 + i, commission: 10 });
      await refund(s.paymentId, s.orderId, 20 + i, 100, "2027-01-20T10:00:00.000Z");
    }
    queries = 0;
    await financeFacts(database, { organizerId: orgB });
    expect(queries).toBe(before);
  });
});
