import { HttpException } from "@nestjs/common";
import { describe,expect,it } from "vitest";
import { MediaLimiter,mediaConcurrency } from "./media-limiter.js";

const gate=()=>{let open!:()=>void;const promise=new Promise<void>(resolve=>{open=resolve;});return{promise,open};};

describe("MediaLimiter",()=>{
  it("never exceeds the concurrency limit",async()=>{
    const limiter=new MediaLimiter(2,10);let running=0,peak=0;
    await Promise.all(Array.from({length:8},()=>limiter.run(async()=>{running++;peak=Math.max(peak,running);await new Promise(r=>setTimeout(r,5));running--;})));
    expect(peak).toBe(2);expect(limiter.stats).toEqual({active:0,queued:0});
  });
  it("rejects with 503 MEDIA_BUSY when the queue is full",async()=>{
    const limiter=new MediaLimiter(1,1),g=gate();
    const first=limiter.run(()=>g.promise),queued=limiter.run(async()=>"ok");
    const error=await limiter.run(async()=>"x").catch((e:unknown)=>e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(503);
    expect((error as HttpException).getResponse()).toMatchObject({code:"MEDIA_BUSY",retryAfterSeconds:10});
    g.open();await first;expect(await queued).toBe("ok");
  });
  it("releases the slot when a task throws",async()=>{
    const limiter=new MediaLimiter(1,1);
    await expect(limiter.run(async()=>{throw new Error("boom");})).rejects.toThrow("boom");
    expect(limiter.stats).toEqual({active:0,queued:0});
    expect(await limiter.run(async()=>"after")).toBe("after");
  });
  it("clamps configured concurrency",()=>{
    expect(mediaConcurrency(undefined)).toBe(2);expect(mediaConcurrency("0")).toBe(2);expect(mediaConcurrency("99")).toBe(16);expect(mediaConcurrency("4")).toBe(4);
  });
});
