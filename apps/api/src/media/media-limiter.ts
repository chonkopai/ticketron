import { HttpException,HttpStatus } from "@nestjs/common";

export const MEDIA_RETRY_AFTER_SECONDS=10;

/** Counting semaphore with a bounded wait queue for CPU-heavy media work (ffmpeg, sharp). */
export class MediaLimiter {
  private active=0;
  private readonly waiters:Array<()=>void>=[];
  constructor(readonly concurrency:number,readonly maxQueue:number=concurrency*4){}
  get stats(){return{active:this.active,queued:this.waiters.length};}
  async run<T>(task:()=>Promise<T>):Promise<T>{
    if(this.active>=this.concurrency){
      if(this.waiters.length>=this.maxQueue)throw new HttpException({code:"MEDIA_BUSY",retryAfterSeconds:MEDIA_RETRY_AFTER_SECONDS},HttpStatus.SERVICE_UNAVAILABLE,{});
      // The releasing task hands its slot straight to the next waiter, so active stays accurate.
      await new Promise<void>(resolve=>this.waiters.push(resolve));
    }else this.active++;
    try{return await task();}
    finally{const next=this.waiters.shift();if(next)next();else this.active--;}
  }
}

export function mediaConcurrency(value=process.env.MEDIA_PROCESSING_CONCURRENCY):number{
  const parsed=Number(value);return Number.isInteger(parsed)&&parsed>=1?Math.min(parsed,16):2;
}

let shared:MediaLimiter|undefined;
/** Process-wide limiter shared by every media processing path. Env is validated at startup by @event-platform/config. */
export function sharedMediaLimiter():MediaLimiter{return shared??=new MediaLimiter(mediaConcurrency());}
