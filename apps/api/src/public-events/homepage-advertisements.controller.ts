import {Controller,Get,Header,Inject,Query} from "@nestjs/common";
import {HomepageAdvertisementsService} from "./homepage-advertisements.service.js";
@Controller("events/homepage-advertisements")
export class HomepageAdvertisementsController {
 constructor(@Inject(HomepageAdvertisementsService) private ads:HomepageAdvertisementsService){}
 @Get() @Header("Cache-Control","no-store") list(@Query("locale") locale?:string){return this.ads.publicList(locale);}
}
