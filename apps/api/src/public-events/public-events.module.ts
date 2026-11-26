import {HomepageAdvertisementsService} from "./homepage-advertisements.service.js";
import {HomepageAdvertisementsController} from "./homepage-advertisements.controller.js";
import { prisma } from "@event-platform/database";
import { Module } from "@nestjs/common";

import { DATABASE_CLIENT } from "../auth/auth.constants.js";
import { TablesModule } from "../tables/tables.module.js";
import { TicketTypesModule } from "../ticket-types/ticket-types.module.js";
import { PublicEventsController } from "./public-events.controller.js";
import { PublicEventsService } from "./public-events.service.js";

@Module({
  imports: [TicketTypesModule, TablesModule],
  controllers: [HomepageAdvertisementsController,PublicEventsController],
  providers: [{ provide: DATABASE_CLIENT, useValue: prisma }, PublicEventsService,HomepageAdvertisementsService],
  exports: [PublicEventsService,HomepageAdvertisementsService],
})
export class PublicEventsModule {}
