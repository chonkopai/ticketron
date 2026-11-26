import { publicEventWhere } from "../events/event-moderation-policy.js";
import { Controller,Get,Inject,Param,ParseUUIDPipe,Req,Res,StreamableFile,BadRequestException,NotFoundException,UseGuards } from "@nestjs/common";
import { CreationDraftsService } from "./creation-drafts.service.js";
import { DraftMediaStorage } from "./draft-media-storage.js";
import { CurrentUser } from "../auth/auth.decorators.js";
import { JwtAuthGuard } from "../auth/auth.guards.js";
import type { AuthenticatedPrincipal } from "../auth/auth.constants.js";
/** Only safe derivatives of linked published assets are public. */
@Controller("media/events")
export class PublicMediaController {
 constructor(@Inject(CreationDraftsService) readonly drafts:CreationDraftsService,@Inject(DraftMediaStorage) readonly storage:DraftMediaStorage){}
 @Get(":eventId/:assetId/:variant") async read(@Param("eventId",new ParseUUIDPipe()) eventId:string,@Param("assetId",new ParseUUIDPipe()) assetId:string,@Param("variant") variant:string,@Req() request:MediaRequest,@Res({passthrough:true}) response:MediaResponse){
  return readEventMedia(this.drafts, this.storage, eventId, assetId, variant, request, response);
 }
 @Get(":eventId/:assetId/:variant/owner") @UseGuards(JwtAuthGuard)
 async ownerMedia(@CurrentUser() user: AuthenticatedPrincipal,
  @Param("eventId",new ParseUUIDPipe()) eventId:string,@Param("assetId",new ParseUUIDPipe()) assetId:string,
  @Param("variant") variant:string,@Req() request:{headers:{range?:string}},
  @Res({passthrough:true}) response:{status(value:number):void;setHeader(name:string,value:string):void}){
  const owned = await this.drafts.database.event.findFirst({ where: { id: eventId, organizerId: user.userId }, select: { id: true } });
  if (!owned) throw new NotFoundException();
  return readEventMedia(this.drafts, this.storage, eventId, assetId, variant, request, response, true);
 }
}
type MediaRequest = { headers: { range?: string; "if-none-match"?: string } };
type MediaResponse = { status(value: number): void; setHeader(name: string, value: string): void };
/**
 * Published derivatives are immutable per asset id and variant (they are written
 * once by the media processor), so the public route is cacheable by browsers and
 * a CDN. max-age stays at one day so a moderation takedown ages out of caches;
 * the ETag lets a revalidation skip the file stream. Owner and staff previews of
 * unpublished media stay `private, no-store`.
 */
const PUBLIC_MEDIA_CACHE_CONTROL = "public, max-age=86400, immutable";
export async function readEventMedia(drafts: CreationDraftsService, storage: DraftMediaStorage, eventId: string, assetId: string, variant: string,
 request: MediaRequest, response: MediaResponse, preview=false) {
  if(!["display","poster","thumbnail"].includes(variant))throw new NotFoundException();
  const link=await drafts.database.eventMedia.findFirst({where:{eventId,assetId,...(!preview ? {event:publicEventWhere} : {}),asset:{state:"ready",deletingAt:null}},include:{asset:true}});if(!link)throw new NotFoundException();
  const file=(link.asset.derivatives as Record<string,string>)[variant];if(!file)throw new NotFoundException();
  response.setHeader("X-Content-Type-Options","nosniff");
  if(preview)response.setHeader("Cache-Control","private, no-store");
  else{
   const etag=`"${assetId}-${variant}"`;
   response.setHeader("Cache-Control",PUBLIC_MEDIA_CACHE_CONTROL);response.setHeader("ETag",etag);
   if(!request.headers.range&&request.headers["if-none-match"]?.split(",").some(value=>value.trim().replace(/^W\//,"")===etag)){response.status(304);return undefined;}
  }
  const {size}=await storage.info(assetId,file);let start:number|undefined,end:number|undefined;
  if(request.headers.range){const match=/^bytes=(\d+)-(\d*)$/.exec(request.headers.range);if(!match)throw new BadRequestException({code:"MEDIA_RANGE_INVALID"});start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),size-1):size-1;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||end<start)throw new BadRequestException({code:"MEDIA_RANGE_INVALID"});response.status(206);response.setHeader("Content-Range",`bytes ${start}-${end}/${size}`);}
  response.setHeader("Accept-Ranges","bytes");return new StreamableFile(storage.read(assetId,file,start,end),{type:file.endsWith("mp4")?"video/mp4":"image/webp",length:start!==undefined?end!-start+1:size});
}
