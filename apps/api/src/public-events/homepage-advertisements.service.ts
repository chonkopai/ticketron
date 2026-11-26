import {Inject,Injectable,BadRequestException,ConflictException,ForbiddenException,NotFoundException} from "@nestjs/common";
import type {Prisma,PrismaClient} from "@event-platform/database";
import {homepageAdAddSchema,homepageAdMoveSchema,homepageAdEvent,type HomepageAdPlacement,type EventLocale} from "@event-platform/shared-types";
import {DATABASE_CLIENT} from "../auth/auth.constants.js";
import {publicEventWhere} from "../events/event-moderation-policy.js";
import {PublicEventsService} from "./public-events.service.js";
import {parse,staffAudit,type StaffPrincipal} from "../staff/staff.config.js";
const ordered=[{position:"asc" as const},{eventId:"asc" as const}];
const localeValue=(value?:string)=>["ru","kk","en"].includes(value??"")?value as EventLocale:"ru";
@Injectable()
export class HomepageAdvertisementsService {
 constructor(@Inject(DATABASE_CLIENT) private db:PrismaClient,@Inject(PublicEventsService) private events:PublicEventsService){}
 async publicList(locale?:string) {
  const rows=await this.db.homepageAdvertisement.findMany({where:{event:publicEventWhere},orderBy:ordered,select:{eventId:true}});
  const events=await Promise.all(rows.map(row=>this.events.summary(row.eventId,new Date(),localeValue(locale))));
  return {items:events.filter(event=>event!==null).map(homepageAdEvent)};
 }
 async adminList(locale?:string) {
  const rows=await this.db.homepageAdvertisement.findMany({orderBy:ordered,include:{event:true}});
  const items=await Promise.all(rows.map(async row=>{
   const summary=await this.events.summary(row.eventId,new Date(),localeValue(locale));
   const event=summary?homepageAdEvent(summary):{id:row.eventId,title:row.event.title,posterUrl:row.event.posterUrl?.replace(`/media/events/${row.eventId}/`,`/staff-api/events/${row.eventId}/media/`)??null,date:row.event.date.toISOString().slice(0,10),time:row.event.time.toISOString().slice(11,16),startsAt:row.event.startsAt?.toISOString()??"",timezone:row.event.timezone,address:row.event.address,city:row.event.city,countryCode:row.event.countryCode};
   return {eventId:row.eventId,position:row.position,eligible:!!summary,event} satisfies HomepageAdPlacement;
  }));
  return {items};
 }
 async candidates(searchInput?:string,locale?:string) {
  const search=searchInput?.trim().slice(0,120);
  const rows=await this.db.event.findMany({where:{...publicEventWhere,...(search?{OR:[{title:{contains:search,mode:"insensitive"}},{contents:{some:{title:{contains:search,mode:"insensitive"}}}},{translations:{some:{title:{contains:search,mode:"insensitive"}}}}]}:{})},select:{id:true},orderBy:[{date:"asc"},{id:"asc"}],take:20});
  const events=await Promise.all(rows.map(row=>this.events.summary(row.id,new Date(),localeValue(locale))));
  return {items:events.filter(event=>event!==null).map(homepageAdEvent)};
 }
 private moderator(actor:StaffPrincipal) {if(actor.role!=="moderator") throw new ForbiddenException({code:"MODERATOR_REQUIRED"});}
 private async lock(tx:Prisma.TransactionClient) {
  // Serialize small placement edits, so simultaneous admins cannot overwrite order.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('homepage-advertisements',0))`;
 }
 async add(actor:StaffPrincipal,body:unknown,locale?:string) {
  this.moderator(actor);const {eventId}=parse(homepageAdAddSchema,body);
  await this.db.$transaction(async tx=>{
   await this.lock(tx);
   await tx.$queryRaw`SELECT id FROM "Event" WHERE id=${eventId}::uuid FOR SHARE`;
   const event=await tx.event.findFirst({where:{id:eventId,...publicEventWhere},select:{title:true}});
   if(!event) throw new ConflictException({code:"HOMEPAGE_AD_INELIGIBLE"});
   if(await tx.homepageAdvertisement.findUnique({where:{eventId}})) throw new ConflictException({code:"HOMEPAGE_AD_DUPLICATE"});
   const last=await tx.homepageAdvertisement.findFirst({orderBy:{position:"desc"},select:{position:true}}),position=(last?.position??-1)+1;
   await tx.homepageAdvertisement.create({data:{eventId,position}});
   await staffAudit(tx,actor,"homepage_ad.added","event",eventId,undefined,{title:event.title,selected:false},{title:event.title,selected:true,position});
  });
  return this.adminList(locale);
 }
 async remove(actor:StaffPrincipal,eventId:string,locale?:string) {
  this.moderator(actor);if(!homepageAdAddSchema.safeParse({eventId}).success) throw new BadRequestException({code:"ID_INVALID"});
  await this.db.$transaction(async tx=>{
   await this.lock(tx);
   const row=await tx.homepageAdvertisement.findUnique({where:{eventId},include:{event:{select:{title:true}}}});
   if(!row) return;
   await tx.homepageAdvertisement.delete({where:{eventId}});
   await tx.homepageAdvertisement.updateMany({where:{position:{gt:row.position}},data:{position:{decrement:1}}});
   await staffAudit(tx,actor,"homepage_ad.removed","event",eventId,undefined,{title:row.event.title,selected:true,position:row.position},{title:row.event.title,selected:false});
  });
  return this.adminList(locale);
 }
 async move(actor:StaffPrincipal,eventId:string,body:unknown,locale?:string) {
  this.moderator(actor);const {direction}=parse(homepageAdMoveSchema,body);
  if(!homepageAdAddSchema.safeParse({eventId}).success) throw new BadRequestException({code:"ID_INVALID"});
  await this.db.$transaction(async tx=>{
   await this.lock(tx);
   const rows=await tx.homepageAdvertisement.findMany({orderBy:ordered,include:{event:{select:{title:true}}}}),index=rows.findIndex(row=>row.eventId===eventId);
   if(index<0) throw new NotFoundException({code:"HOMEPAGE_AD_NOT_FOUND"});
   const row=rows[index]!,other=rows[index+(direction==="up"?-1:1)];if(!other) return;
   await tx.homepageAdvertisement.update({where:{eventId},data:{position:other.position}});
   await tx.homepageAdvertisement.update({where:{eventId:other.eventId},data:{position:row.position}});
   await staffAudit(tx,actor,"homepage_ad.reordered","event",eventId,undefined,{title:row.event.title,position:row.position},{title:row.event.title,position:other.position});
  });
  return this.adminList(locale);
 }
}
