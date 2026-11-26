import "reflect-metadata";
import {Readable} from "node:stream";
import {randomUUID} from "node:crypto";
import {Module, UnauthorizedException} from "@nestjs/common";
import {AuthService} from "../auth/auth.service.js";
import {NestFactory} from "@nestjs/core";
import {beforeAll,afterAll,describe,expect,it,vi} from "vitest";
import {PublicMediaController} from "./public-media.controller.js";
import {CreationDraftsService} from "./creation-drafts.service.js";
import {DraftMediaStorage} from "./draft-media-storage.js";
const eventId=randomUUID(),assetId=randomUUID(),bytes=Buffer.from("safe-processed-media"),lookup=vi.fn(async({where}:{where:{eventId:string;assetId:string}})=>where.eventId===eventId&&where.assetId===assetId?{asset:{derivatives:{display:"safe.mp4",poster:"poster.webp"}}}:null);
const ownerId=randomUUID(),otherUserId=randomUUID();
const authenticate=async(token:string)=>{
 if(token==="owner-fixture")return {userId:ownerId};
 if(token==="other-fixture")return {userId:otherUserId};
 throw new UnauthorizedException();
};
@Module({controllers:[PublicMediaController],providers:[{provide:AuthService,useValue:{authenticate}},{provide:CreationDraftsService,useValue:{database:{event:{findFirst:async({where}:{where:{id:string;organizerId:string}})=>where.id===eventId&&where.organizerId===ownerId?{id:eventId}:null},eventMedia:{findFirst:lookup}}}},{provide:DraftMediaStorage,useValue:{info:async()=>({size:bytes.length}),read:(_id:string,_file:string,start=0,end=bytes.length-1)=>Readable.from([bytes.subarray(start,end+1)])}}]})class TestModule{}
describe("public processed media HTTP boundary",()=>{
 let app:Awaited<ReturnType<typeof NestFactory.create>>,origin:string;
 beforeAll(async()=>{app=await NestFactory.create(TestModule,{logger:false});await app.listen(0,"127.0.0.1");origin=await app.getUrl();});afterAll(async()=>{await app.close();});
 it("serves only safe derivatives linked to a published ready asset",async()=>{const response=await fetch(`${origin}/media/events/${eventId}/${assetId}/display`);expect(response.status).toBe(200);expect(response.headers.get("content-type")).toContain("video/mp4");expect(response.headers.get("x-content-type-options")).toBe("nosniff");expect(await response.text()).toBe(bytes.toString());expect(lookup.mock.lastCall?.[0]).toMatchObject({where:{event:{status:"published",approvedAt:{not:null}},asset:{state:"ready",deletingAt:null}}});});
 it("never exposes originals, draft assets or cross-event IDs",async()=>{for(const path of [`${eventId}/${assetId}/original`,`${randomUUID()}/${assetId}/display`,`${eventId}/${randomUUID()}/display`])expect((await fetch(`${origin}/media/events/${path}`)).status).toBe(404);});
 it("supports bounded video ranges and rejects invalid multi/range requests",async()=>{const response=await fetch(`${origin}/media/events/${eventId}/${assetId}/display`,{headers:{range:"bytes=5-8"}});expect(response.status).toBe(206);expect(response.headers.get("content-range")).toBe(`bytes 5-8/${bytes.length}`);expect(await response.text()).toBe(bytes.subarray(5,9).toString());for(const range of ["bytes=999-1000","bytes=8-5","bytes=1-2,5-6"])expect((await fetch(`${origin}/media/events/${eventId}/${assetId}/display`,{headers:{range}})).status).toBe(400);});
 it("lets browsers and a CDN cache published derivatives and revalidate by asset id and variant",async()=>{
   const url=`${origin}/media/events/${eventId}/${assetId}/display`;
   const first=await fetch(url);
   expect(first.headers.get("cache-control")).toBe("public, max-age=86400, immutable");
   expect(first.headers.get("etag")).toBe(`"${assetId}-display"`);
   const poster=await fetch(`${origin}/media/events/${eventId}/${assetId}/poster`);
   expect(poster.headers.get("etag")).toBe(`"${assetId}-poster"`);
   const revalidated=await fetch(url,{headers:{"if-none-match":`W/"${assetId}-display"`}});
   expect(revalidated.status).toBe(304);
   expect(await revalidated.text()).toBe("");
   expect((await fetch(url,{headers:{"if-none-match":`"${assetId}-poster"`}})).status).toBe(200);
   // A not-found asset must not be confirmed by a cached validator.
   expect((await fetch(`${origin}/media/events/${eventId}/${randomUUID()}/display`,{headers:{"if-none-match":`"${assetId}-display"`}})).status).toBe(404);
 });
 it("serves an unpublished derivative only to the owning organizer",async()=>{
   const url=`${origin}/media/events/${eventId}/${assetId}/display/owner`;
   expect((await fetch(url)).status).toBe(401);
   expect((await fetch(url,{headers:{authorization:"Bearer other-fixture"}})).status).toBe(404);
   const response=await fetch(url,{headers:{authorization:"Bearer owner-fixture"}});
   expect(response.status).toBe(200);
   expect(response.headers.get("cache-control")).toBe("private, no-store");
   expect(lookup.mock.lastCall?.[0].where).not.toHaveProperty("event");
 });
});
