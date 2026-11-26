import type { PrismaClient } from "@event-platform/database";
import { EVENT_LOCALES, type BotGuestSettings, type BotGuestSettingsUpdate, type EventLocale, type NotificationPreferences } from "@event-platform/shared-types";
import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { AccountService } from "../auth/account.service.js";
import { DATABASE_CLIENT } from "../auth/auth.constants.js";
import { requirePrivateChatActor } from "./bot-purchase-access.js";

@Injectable()
export class BotGuestService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly db: PrismaClient,
    @Inject(AccountService) private readonly account: AccountService,
  ) {}

  async settings(telegramId: string, chatId: string): Promise<BotGuestSettings> {
    const id = requirePrivateChatActor(telegramId, chatId);
    const [user, preference] = await Promise.all([
      this.linkedUser(id),
      this.db.telegramGuestPreference.findUnique({ where: { telegramId: id } }),
    ]);
    const locale = EVENT_LOCALES.find(value => value === preference?.locale) ?? null;
    const city = preference?.locationSet ? preference.city : user?.defaultCity;
    const countryCode = preference?.locationSet ? preference.countryCode : user?.defaultCountry;
    return {
      locale, location: city ? { city, countryCode: countryCode ?? null } : null, linked: !!user,
      canOrganize: process.env.TELEGRAM_BOT_ORGANIZER_ENABLED !== "false" && !!user && !user.blockedAt && (user.role === "organizer" || user.role === "admin"),
    };
  }

  async update(telegramId: string, chatId: string, input: BotGuestSettingsUpdate): Promise<BotGuestSettings> {
    const id = requirePrivateChatActor(telegramId, chatId);
    const currentUser = await this.db.user.findUnique({ where: { telegramId: id }, select: { blockedAt: true } });
    if (currentUser?.blockedAt) throw new ForbiddenException({ code: "ACCOUNT_RESTRICTED" });
    const data = {
      ...(input.locale ? { locale: input.locale } : {}),
      ...(input.location !== undefined ? { locationSet: true, city: input.location?.city ?? null, countryCode: input.location?.countryCode ?? null } : {}),
    };
    await this.db.telegramGuestPreference.upsert({ where: { telegramId: id }, create: { telegramId: id, ...data }, update: data });
    return this.settings(telegramId, chatId);
  }

  async messages(telegramId: string, chatId: string, locale: EventLocale, page: number) {
    const user = await this.linkedUser(requirePrivateChatActor(telegramId, chatId));
    if (!user) throw new NotFoundException({ code: "BOT_IDENTITY_NOT_LINKED" });
    if (user.blockedAt) throw new ForbiddenException({ code: "ACCOUNT_RESTRICTED" });
    return this.account.notifications(user.id, { locale, page, limit: 5 }, true);
  }

  async preferences(telegramId: string, chatId: string, changes?: Partial<Pick<NotificationPreferences, "eventReminders" | "transactionalTicketDelivery">>) {
    const user = await this.linkedUser(requirePrivateChatActor(telegramId, chatId));
    if (!user) throw new NotFoundException({ code: "BOT_IDENTITY_NOT_LINKED" });
    if (user.blockedAt) throw new ForbiddenException({ code: "ACCOUNT_RESTRICTED" });
    return changes ? this.account.updatePreferences(user.id, changes) : this.account.preferences(user.id);
  }

  async readAlert(telegramId: string, chatId: string, id: string) {
    const user = await this.linkedUser(requirePrivateChatActor(telegramId, chatId));
    if (!user) throw new NotFoundException({ code: "BOT_IDENTITY_NOT_LINKED" });
    if (user.blockedAt) throw new ForbiddenException({ code: "ACCOUNT_RESTRICTED" });
    return this.account.readNotification(user.id, id);
  }

  private linkedUser(id: bigint) {
    return this.db.user.findUnique({
      where: { telegramId: id, telegramChatId: id },
      select: { id: true, role: true, blockedAt: true, defaultCity: true, defaultCountry: true },
    });
  }
}
