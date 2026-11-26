import { afterEach, describe, expect, it, vi } from "vitest";

import { errorCode, ExclusiveRunner, startIntervalWorker } from "./interval-worker.js";

afterEach(() => { vi.useRealTimers(); });

describe("interval worker overlap guard (§12 #13)", () => {
  it("skips a tick while the previous run of the same worker is still in progress", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let runs = 0;
    const task = vi.fn(() => { runs++; return new Promise<void>((resolve) => { release = resolve; }); });
    const timer = startIntervalWorker({ name: "Test worker", intervalMs: 1_000, task, logger: { error: vi.fn() } as never });
    await vi.advanceTimersByTimeAsync(3_500);
    expect(runs).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runs).toBe(2);
    clearInterval(timer);
  });

  it("logs a failed run with its error code only and keeps ticking", async () => {
    vi.useFakeTimers();
    const error = vi.fn();
    const task = vi.fn().mockRejectedValueOnce(Object.assign(new Error("duplicate key for guest@example.test"), { code: "P2002" })).mockResolvedValue(undefined);
    const timer = startIntervalWorker({ name: "Test worker", intervalMs: 1_000, task, logger: { error } as never });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(task).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith("Test worker failed: P2002");
    expect(JSON.stringify(error.mock.calls)).not.toContain("@example.test");
    clearInterval(timer);
  });

  it("runs once immediately when asked", async () => {
    vi.useFakeTimers();
    const task = vi.fn(async () => undefined);
    const timer = startIntervalWorker({ name: "Test worker", intervalMs: 60_000, task, runImmediately: true, logger: { error: vi.fn() } as never });
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(1);
    clearInterval(timer);
  });

  it("ExclusiveRunner reports a skipped run", async () => {
    const runner = new ExclusiveRunner();
    let release!: () => void;
    const first = runner.run(() => new Promise<string>((resolve) => { release = () => resolve("done"); }));
    expect(await runner.run(async () => "second")).toEqual({ ran: false });
    release();
    expect(await first).toEqual({ ran: true, value: "done" });
  });

  it("never echoes free-form error text", () => {
    expect(errorCode(new Error("token abc for guest@example.test"))).toBe("Error");
    expect(errorCode({ code: "has spaces and @" })).toBe("UNKNOWN_ERROR");
    expect(errorCode({ response: { code: "TICKET_EMAIL_UNAVAILABLE" } })).toBe("TICKET_EMAIL_UNAVAILABLE");
  });
});
