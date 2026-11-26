import { Controller, Get, Inject, Param, ParseUUIDPipe, Query, Req, Res, UseGuards, Header } from "@nestjs/common";
import { PublicEventsService } from "../public-events/public-events.service.js";
import { SeatsService } from "../seats/seats.service.js";
import { CreationDraftsService } from "../creation-drafts/creation-drafts.service.js";
import { DraftMediaStorage } from "../creation-drafts/draft-media-storage.js";
import { readEventMedia } from "../creation-drafts/public-media.controller.js";
import { StaffGatewayGuard, StaffSessionGuard } from "./staff.guards.js";
@Controller("staff/events")
@UseGuards(StaffGatewayGuard, StaffSessionGuard)
export class StaffEventPreviewController {
  constructor(@Inject(PublicEventsService) private events: PublicEventsService, @Inject(SeatsService) private seats: SeatsService,
    @Inject(CreationDraftsService) private drafts: CreationDraftsService, @Inject(DraftMediaStorage) private storage: DraftMediaStorage) {}
  @Get(":id/preview")
  @Header("Cache-Control", "private, no-store")
  async preview(@Param("id", new ParseUUIDPipe()) id: string, @Query("locale") locale?: string) {
    const event = await this.events.preview(id, locale), layout = await this.seats.publicForEvent(id, locale, true);
    const privateUrl = (url: string | null) => url?.replace(`/media/events/${id}/`, `/staff-api/events/${id}/media/`) ?? null;
    return { event: { ...event, posterUrl: privateUrl(event.posterUrl), galleryUrls: (event.galleryUrls ?? []).map(url => privateUrl(url)!),
      ...(event.media ? { media: event.media.map(asset => ({ ...asset, url: privateUrl(asset.url)!, posterUrl: privateUrl(asset.posterUrl) })) } : {}) }, layout };
  }
  @Get(":id/media/:assetId/:variant")
  async media(@Param("id", new ParseUUIDPipe()) id: string, @Param("assetId", new ParseUUIDPipe()) assetId: string, @Param("variant") variant: string,
    @Req() request:{headers:{range?:string}}, @Res({passthrough:true}) response:{status(value:number):void;setHeader(name:string,value:string):void}) {
    return readEventMedia(this.drafts, this.storage, id, assetId, variant, request, response, true);
  }
}
