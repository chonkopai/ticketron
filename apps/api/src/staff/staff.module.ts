import {StaffHomepageAdsController} from "./staff-homepage-ads.controller.js";
import { PublicEventsModule } from "../public-events/public-events.module.js";
import { SeatsModule } from "../seats/seats.module.js";
import { CreationDraftsModule } from "../creation-drafts/creation-drafts.module.js";
import { StaffEventPreviewController } from "./staff-event-preview.controller.js";
import { Module } from "@nestjs/common";
import { prisma } from "@event-platform/database";
import { EventsModule } from "../events/events.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { BookingModule } from "../booking/booking.module.js";
import { DATABASE_CLIENT } from "../auth/auth.constants.js";
import { STAFF_CONFIG, staffConfig } from "./staff.config.js";
import { StaffAuthService } from "./staff-auth.service.js";
import {
  StaffGatewayGuard,
  StaffPendingGuard,
  StaffSessionGuard,
} from "./staff.guards.js";
import { StaffAuthController } from "./staff-auth.controller.js";
import { PlatformSupportService } from "./platform-support.service.js";
import {
  PlatformSupportController,
  SupportParticipantGuard,
} from "./platform-support.controller.js";
import { StaffSupportController } from "./staff-support.controller.js";
import { StaffManagementService } from "./staff-management.service.js";
import { StaffManagementController } from "./staff-management.controller.js";
import { StaffRefundsService } from "./staff-refunds.service.js";
@Module({
  imports: [AuthModule, BookingModule, EventsModule, PublicEventsModule, SeatsModule, CreationDraftsModule],
  controllers: [
    StaffAuthController,
    PlatformSupportController,
    StaffSupportController,
    StaffManagementController,
    StaffEventPreviewController,
    StaffHomepageAdsController,
  ],
  providers: [
    { provide: DATABASE_CLIENT, useValue: prisma },
    { provide: STAFF_CONFIG, useFactory: staffConfig },
    StaffAuthService,
    StaffGatewayGuard,
    StaffPendingGuard,
    StaffSessionGuard,
    SupportParticipantGuard,
    PlatformSupportService,
    StaffManagementService,
    StaffRefundsService,
  ],
})
export class StaffModule {}
