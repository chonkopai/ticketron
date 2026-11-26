import { describe, expect, it } from "vitest";
import { orderBelongsOnlyToEvent, orderBelongsToEvent, orderEventIds, orderSoleEventId } from "./order-event.js";

const ticket = (eventId: string) => ({ ticketType: { eventId } });

describe("order event resolution", () => {
  it("prefers the order column", () => {
    expect([...orderEventIds({ eventId: "a", tickets: [ticket("b")] })]).toEqual(["a"]);
  });

  it("derives events from every relation for legacy orders", () => {
    const ids = orderEventIds({
      eventId: null,
      tickets: [ticket("a")],
      reservations: [ticket("a")],
      seatAllocations: [{ seat: { venueLayout: { eventId: "a" } } }, { seat: { venueLayout: { eventId: null } } }],
      booking: { table: { venueLayout: { eventId: "a" } } },
      deposit: { eventId: "a" },
    });
    expect([...ids]).toEqual(["a"]);
  });

  it("rejects orders spanning events or without any", () => {
    expect(orderSoleEventId({ tickets: [ticket("a"), ticket("b")] })).toBeNull();
    expect(orderSoleEventId({})).toBeNull();
    expect(orderBelongsOnlyToEvent({ tickets: [ticket("a")] }, "a")).toBe(true);
    expect(orderBelongsOnlyToEvent({ tickets: [ticket("a")] }, "b")).toBe(false);
  });

  it("builds a column-or-legacy filter", () => {
    expect(orderBelongsToEvent("a")).toMatchObject({ OR: [{ eventId: "a" }, { eventId: null }] });
  });
});
