import { loadApiEnv } from "@event-platform/config";
import { prisma } from "@event-platform/database";
import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { DATABASE_CLIENT } from "../auth/auth.constants.js";
import { BookingModule } from "../booking/booking.module.js";
import { PublicEventsModule } from "../public-events/public-events.module.js";
import { TicketsModule } from "../tickets/tickets.module.js";
import { BotController } from "./bot.controller.js";
import { BotService } from "./bot.service.js";
import { BotCheckoutService } from "./bot-checkout.service.js";
import { BotGuestService } from "./bot-guest.service.js";
import { BotWalletController } from "./bot-wallet.controller.js";
import { BotWalletService } from "./bot-wallet.service.js";
import { QuickRateGuard } from "../orders/quick.guards.js";
import { SeatsModule } from "../seats/seats.module.js";
import { TelegramSeatController } from "./telegram-seat.controller.js";
import { TELEGRAM_SEAT_CONFIG, TelegramSeatService } from "./telegram-seat.service.js";
import { EventsModule } from "../events/events.module.js";
import { BotCompanionController } from "./bot-companion.controller.js";
import { BotConversationsService } from "./bot-conversations.service.js";
import { BotOrganizerService } from "./bot-organizer.service.js";

@Module({
  imports: [AuthModule, BookingModule, EventsModule, PublicEventsModule, SeatsModule, TicketsModule],
  controllers: [BotController, BotWalletController, TelegramSeatController, BotCompanionController],
  providers: [
    { provide: DATABASE_CLIENT, useValue: prisma },
    {
      provide: TELEGRAM_SEAT_CONFIG,
      useFactory: () => {
        const env = loadApiEnv();
        return { enabled: env.TELEGRAM_SEAT_MINI_APP_ENABLED, token: env.TELEGRAM_BOT_TOKEN, botUsername: env.TELEGRAM_BOT_USERNAME };
      },
    },
    BotService, BotCheckoutService, BotGuestService, BotWalletService, QuickRateGuard, TelegramSeatService,
    BotConversationsService, BotOrganizerService,
  ],
})
export class BotModule {}
