import {Controller,Get,Post,Patch,Delete,Inject,Query,Body,Param,ParseUUIDPipe,Req,UseGuards} from "@nestjs/common";
import {HomepageAdvertisementsService} from "../public-events/homepage-advertisements.service.js";
import {StaffGatewayGuard,StaffSessionGuard,StaffRoles,type StaffRequest} from "./staff.guards.js";
@Controller("staff/homepage-ads")
@UseGuards(StaffGatewayGuard,StaffSessionGuard)
@StaffRoles("moderator")
export class StaffHomepageAdsController {
 constructor(@Inject(HomepageAdvertisementsService) private ads:HomepageAdvertisementsService){}
 @Get() list(@Query("locale") locale?:string){return this.ads.adminList(locale);}
 @Get("events") search(@Query("search") search?:string,@Query("locale") locale?:string){return this.ads.candidates(search,locale);}
 @Post() add(@Req() req:StaffRequest,@Body() body:unknown,@Query("locale") locale?:string){return this.ads.add(req.staff,body,locale);}
 @Delete(":eventId") remove(@Req() req:StaffRequest,@Param("eventId",new ParseUUIDPipe()) id:string,@Query("locale") locale?:string){return this.ads.remove(req.staff,id,locale);}
 @Patch(":eventId") move(@Req() req:StaffRequest,@Param("eventId",new ParseUUIDPipe()) id:string,@Body() body:unknown,@Query("locale") locale?:string){return this.ads.move(req.staff,id,body,locale);}
}
