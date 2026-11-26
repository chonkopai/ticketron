import { databaseSuiteEnabled } from "../src/test-database-guard.js";
import { OrderType, prisma } from "../src/index.js";
import { afterAll, describe, expect, it } from "vitest";

// The Order sale guard must look Event/User up by native uuid/bigint
// keys (index scans) and keep the exact matching semantics of the old ::text form.
const run = databaseSuiteEnabled("Order sale guard typed keys", "DATABASE_TESTS");
afterAll(async () => {
  await prisma.$disconnect();
});

(run ? describe : describe.skip)("Order sale guard typed keys", () => {
  it("does not cast the indexed Event.id / User.telegramId columns to text", async () => {
    const [row] = await prisma.$queryRaw<Array<{ source: string }>>`SELECT pg_get_functiondef('platform_order_sale_guard'::regproc) AS source`;
    const source = row?.source ?? "";
    expect(source).not.toMatch(/id::text\s*=/);
    expect(source).not.toMatch(/"telegramId"::text\s*=/);
    expect(source).toMatch(/id=event_key::uuid/);
    expect(source).toMatch(/"telegramId"=telegram_key::bigint/);
  });

  it("still blocks unapproved events and restricted Telegram guests, and ignores malformed keys", async () => {
    const telegramId = BigInt(Date.now()) * 1000n + 7n;
    const organizer = await prisma.user.create({ data: { role: "organizer" } });
    const guest = await prisma.user.create({ data: { role: "guest", telegramId, blockedAt: new Date() } });
    const event = await prisma.event.create({ data: {
      organizerId: organizer.id, title: "Sale guard fixture", date: new Date("2030-01-01"), time: new Date("1970-01-01T19:00Z"), address: "Test", status: "published",
    } });
    const orderIds: string[] = [];
    const order = (data: { guestContact?: object; checkoutSnapshot?: object }) =>
      prisma.order.create({ data: { type: OrderType.ticket, amount: 1000, currency: "KZT", ...data } }).then(created => { orderIds.push(created.id); return created; });
    try {
      await expect(order({ checkoutSnapshot: { eventId: event.id } })).rejects.toThrow(/EVENT_SALES_PAUSED/);
      await expect(order({ guestContact: { channel: "telegram", telegramId: telegramId.toString() } })).rejects.toThrow(/ACCOUNT_RESTRICTED/);
      // Non-canonical forms never matched the old text comparison either.
      await expect(order({ guestContact: { channel: "telegram", telegramId: `0${telegramId}` }, checkoutSnapshot: { eventId: event.id.toUpperCase() } })).resolves.toMatchObject({ commissionBps: null });
      await expect(order({ guestContact: { channel: "telegram", telegramId: "99999999999999999999999" }, checkoutSnapshot: { eventId: "not-a-uuid" } })).resolves.toBeTruthy();
      await prisma.event.update({ where: { id: event.id }, data: { approvedAt: new Date(), moderationStatus: "approved" } });
      await expect(order({ checkoutSnapshot: { eventId: event.id } })).resolves.toBeTruthy();
    } finally {
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      await prisma.event.delete({ where: { id: event.id } });
      await prisma.user.deleteMany({ where: { id: { in: [organizer.id, guest.id] } } });
    }
  });
});
