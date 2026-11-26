import { publicEventWhere } from "../events/event-moderation-policy.js";
import { Prisma, TicketStatus, eventV2CompatibilityRead, type PrismaClient } from "@event-platform/database";
import type {
  EventCategory,
  EventLocale,
  PublicEvent,
  PublicEventList,
  PublicEventSummary,
  PublicSaleStatus,
  PublicTable,
  PublicTicketType,
} from "@event-platform/shared-types";
import { matchesEventTimeOfDay, cityAliases, EVENT_LOCALES, zonedInputToIso, hasEventEnded } from "@event-platform/shared-types";
import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";

import { guestEventTiming } from "../tickets/guest-ticket-details.js";
import { currentEventsFilter, currentEventsWhere, currentLegacyEventIds } from "./current-events-filter.js";
import { normalizedPresentation, normalizedPresentationFields } from "./normalized-presentation.js";
import { DATABASE_CLIENT } from "../auth/auth.constants.js";
import { TablesService } from "../tables/tables.service.js";
import { TicketTypesService } from "../ticket-types/ticket-types.service.js";
import { eventContent, eventContentHash } from "../events/event-translation-content.js";

function normalizeLocale(value: string | undefined): EventLocale {
  return EVENT_LOCALES.find((locale) => locale === value) ?? "ru";
}

const LOCALIZED_CITIES: Record<string, Partial<Record<EventLocale, string>>> = {
  "Алматы": { kk: "Алматы", en: "Almaty" },
  "Астана": { kk: "Астана", en: "Astana" },
  "Шымкент": { kk: "Шымкент", en: "Shymkent" },
  "Туркестан": { kk: "Түркістан", en: "Turkestan" },
  "Караганда": { kk: "Қарағанды", en: "Karaganda" },
  "Москва": { kk: "Мәскеу", en: "Moscow" },
  "Ташкент": { kk: "Ташкент", en: "Tashkent" },
};

function localizedCity(city: string, locale: EventLocale): string {
  return LOCALIZED_CITIES[city]?.[locale] ?? city;
}

const LOCALIZED_TICKET_NAMES: Record<string, Partial<Record<EventLocale, string>>> = {
  "Стандарт": { kk: "Стандарт", en: "Standard" },
  "Стандартный билет": { kk: "Стандарт билет", en: "Standard ticket" },
  "Вход": { kk: "Кіру", en: "Entry" },
  "Входной билет": { kk: "Кіру билеті", en: "Admission" },
  "Вход на день": { kk: "Бір күндік билет", en: "Day pass" },
  "VIP-зона": { kk: "VIP аймағы", en: "VIP area" },
  "Лаунж и VIP-зона": { kk: "Лаунж және VIP аймағы", en: "Lounge & VIP" },
  "Участник": { kk: "Қатысушы", en: "Participant" },
  "Студент": { kk: "Студент", en: "Student" },
  "Пара": { kk: "Жұптық билет", en: "Pair ticket" },
  "Парный билет": { kk: "Жұптық билет", en: "Pair ticket" },
  "Партер": { kk: "Партер", en: "Floor" },
  "Балкон": { kk: "Балкон", en: "Balcony" },
  "Взрослый": { kk: "Ересек", en: "Adult" },
  "Детский": { kk: "Балалар билеті", en: "Child" },
  "Обычный билет": { kk: "Қалыпты билет", en: "General admission" },
  "Стартовый пакет": { kk: "Старттық жинақ", en: "Starter pack" },
  "Конференция": { kk: "Конференция", en: "Conference" },
  "Утренний поток": { kk: "Таңғы топ", en: "Morning session" },
  "Дневной поток": { kk: "Күндізгі топ", en: "Afternoon session" },
  "Корпоративное приглашение": { kk: "Корпоративтік шақыру", en: "Corporate invitation" },
  "Семейный": { kk: "Отбасылық", en: "Family" },
  "Тихий сеанс": { kk: "Тыныш сеанс", en: "Quiet session" },
  "Мастер-класс": { kk: "Шеберлік сабағы", en: "Workshop pass" },
  "Семейный билет": { kk: "Отбасылық билет", en: "Family pass" },
  "Фан-зона": { kk: "Жанкүйер аймағы", en: "Fan zone" },
  "Гастрономия": { kk: "Ас аймағы", en: "Food court" },
  "Семейные мастерские": { kk: "Отбасылық шеберханалар", en: "Family workshops" },
  "Танцевальная площадка": { kk: "Би алаңы", en: "Dance floor" },
};

function localizedTicketTypes<T extends PublicEvent["ticketTypes"]>(ticketTypes: T, locale: EventLocale): T {
  if (locale === "ru") return ticketTypes;
  return ticketTypes.map((ticket) => {
    const seat = ticket.name.match(/^Место (\d+)$/);
    const name = seat
      ? locale === "en" ? `Seat ${seat[1]}` : `${seat[1]}-орын`
      : LOCALIZED_TICKET_NAMES[ticket.name]?.[locale] ?? ticket.name;
    return { ...ticket, name };
  }) as T;
}

const LOCALIZED_TABLE_NAMES: Record<string, Partial<Record<EventLocale, string>>> = {
  "Стол у сцены": { kk: "Сахна жанындағы үстел", en: "Stage-side table" },
  "Общий стол": { kk: "Ортақ үстел", en: "Community table" },
  "Мастера керамики": { kk: "Керамика шеберлері", en: "Ceramics makers" },
  "Текстиль и вышивка": { kk: "Тоқыма және кесте", en: "Textiles & embroidery" },
  "Дерево и орнамент": { kk: "Ағаш пен өрнек", en: "Woodwork & ornament" },
};

function localizedTableLabel(value: string, locale: EventLocale): string {
  if (locale === "ru") return value;
  const tableNumber = value.match(/^Стол (\d+)$/);
  if (tableNumber) return locale === "en" ? `Table ${tableNumber[1]}` : `${tableNumber[1]}-үстел`;
  const seatNumber = value.match(/^Место (\d+)$/);
  if (seatNumber) return locale === "en" ? `Seat ${seatNumber[1]}` : `${seatNumber[1]}-орын`;
  return LOCALIZED_TABLE_NAMES[value]?.[locale] ?? value;
}

function localizedTables<T extends PublicEvent["tables"]>(tables: T, locale: EventLocale): T {
  if (locale === "ru") return tables;
  return tables.map((table) => ({
    ...table,
    name: table.name ? localizedTableLabel(table.name, locale) : null,
    seatsDetail: table.seatsDetail.map((seat) => ({ ...seat, label: localizedTableLabel(seat.label, locale) })),
  })) as T;
}

function localizedFields(translation: {
  title: string; address: string;
  description: string | null; program: string | null; rules: string | null;
  visitTerms: string | null; cancellationTerms: string | null; depositTerms: string | null;
  extraConditions: string | null;
}) {
  return {
    title: translation.title, address: translation.address,
    description: translation.description,
    program: translation.program, rules: translation.rules, visitTerms: translation.visitTerms,
    cancellationTerms: translation.cancellationTerms, depositTerms: translation.depositTerms,
    extraConditions: translation.extraConditions,
  };
}

@Injectable()
export class PublicEventsService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(TicketTypesService) private readonly ticketTypes: TicketTypesService,
    @Inject(TablesService) private readonly tables: TablesService,
  ) {}

  async locations(now = new Date()): Promise<Array<{ countryCode: string; cities: string[] }>> {
    const rows = await this.database.event.findMany({
      where: { ...publicEventWhere, AND: [await currentEventsFilter(this.database, now)] },
      select: { countryCode: true, city: true },
      distinct: ["countryCode", "city"],
    });
    const groups = new Map<string, Set<string>>();
    for (const row of rows) {
      const cities = groups.get(row.countryCode) ?? new Set<string>();
      cities.add(row.city);
      groups.set(row.countryCode, cities);
    }
    return [...groups].map(([countryCode, cities]) => ({ countryCode, cities: [...cities].sort() }));
  }

  async list(query: CatalogQuery, now = new Date()): Promise<PublicEventList> {
    const prepared = await this.prepareList(query, now);
    const structuralOnly = !query.timeOfDay && !prepared.search && query.free !== true && query.minPrice === undefined && query.maxPrice === undefined && (!query.datePreset || query.from || query.to);
    // The homepage default (soonest + includeRemaining) and every other
    // structural-only soonest listing is ordered and paged in SQL, so its cost
    // depends on the page size, not on the catalogue size.
    if (structuralOnly && query.sort === "soonest") return this.listSoonestInSql(query, prepared.legacyIds, now);
    // The common recent listing can be paged in SQL. Do this before the costly
    // inventory presenter so later pages are not silently lost after 500 events.
    if (structuralOnly && query.sort === "recent" && !query.includeRemaining) {
      const [total, pageEvents] = await Promise.all([
        this.database.event.count({ where: prepared.where }),
        this.database.event.findMany({
          where: prepared.where,
          orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
          include: { organizer: { select: ORGANIZER_SUMMARY_SELECT } },
        }),
      ]);
      const items = (await this.toSummaries(pageEvents, now, false)).map(publicSummary);
      return { items: await this.localizeSummaries(items, query.locale), page: query.page, limit: query.limit, total, hasNext: query.page * query.limit < total };
    }
    return this.scanList(query, prepared, now);
  }

  /**
   * Reference implementation: evaluates every current event in memory. Used for
   * filters that need live inventory or localized text (search, price, time of
   * day, date presets, popularity), and by tests as the oracle for SQL paging.
   */
  async listByScan(query: CatalogQuery, now = new Date()): Promise<PublicEventList> {
    return this.scanList(query, await this.prepareList(query, now), now);
  }

  private async prepareList(query: CatalogQuery, now: Date) {
    if (query.minPrice !== undefined && query.maxPrice !== undefined && query.minPrice > query.maxPrice) {
      throw new BadRequestException({ code: "EVENT_PRICE_RANGE_INVALID", message: "Minimum price must not exceed maximum price" });
    }
    validateDateRange(query.from, query.to);
    const legacyIds = await currentLegacyEventIds(this.database, now);
    const current = currentEventsWhere(legacyIds, now);
    const where: Prisma.EventWhereInput = { ...publicEventWhere, AND: [current] };
    const search = query.search?.trim();
    if (search) {
      where.OR = [
        { contents:{some:{locale:query.locale??"ru",OR:[{title:{contains:search,mode:"insensitive"}},{address:{contains:search,mode:"insensitive"}}]}} },
        { title: { contains: search, mode: "insensitive" } },
        { city: { contains: search, mode: "insensitive" } },
        { address: { contains: search, mode: "insensitive" } },
        { translations: { some: { locale: query.locale ?? "ru", OR: [
          { title: { contains: search, mode: "insensitive" } },
          { address: { contains: search, mode: "insensitive" } },
        ] } } },
      ];
    }
    if (query.city?.trim()) {
      where.AND = [current, { OR: cityAliases(query.city, query.countryCode).map(city => ({ city: { contains: city, mode: "insensitive" as const } })) }];
    }
    if (query.countryCode) where.countryCode = query.countryCode;
    if (query.category) where.category = query.category;
    if (query.from || query.to) {
      where.date = {
        ...(query.from ? { gte: dateAtUtcStart(query.from) } : {}),
        ...(query.to ? { lte: dateAtUtcEnd(query.to) } : {}),
      };
    }
    return { legacyIds, current, where, search };
  }

  /** Matches first (when includeRemaining), each group by effective start time. */
  private async listSoonestInSql(query: CatalogQuery, legacyIds: string[], now: Date): Promise<PublicEventList> {
    const match = structuralMatchSql(query);
    const from = Prisma.sql`FROM "Event" e JOIN "User" o ON o.id = e."organizerId"
      WHERE e.status = 'published' AND e."approvedAt" IS NOT NULL AND e."moderationStatus" IN ('approved', 'sales_paused') AND o."blockedAt" IS NULL
        AND (e."startsAt" > ${now} OR e."endsAt" > ${now} OR e.id = ANY(${legacyIds}::uuid[]))
        ${query.includeRemaining ? Prisma.empty : Prisma.sql`AND ${match}`}`;
    const skip = (query.page - 1) * query.limit;
    const [counts, rows] = await Promise.all([
      this.database.$queryRaw<Array<{ total: number; matching: number }>>`SELECT count(*)::int AS total, (count(*) FILTER (WHERE ${match}))::int AS matching ${from}`,
      this.database.$queryRaw<Array<{ id: string }>>`SELECT e.id::text AS id ${from}
        ORDER BY CASE WHEN ${match} THEN 0 ELSE 1 END, COALESCE(e."startsAt", (e."date" + e."time") AT TIME ZONE e."timezone"), e.id
        LIMIT ${query.limit} OFFSET ${skip}`,
    ]);
    const { total, matching } = counts[0] ?? { total: 0, matching: 0 };
    const events = rows.length ? await this.database.event.findMany({ where: { id: { in: rows.map(row => row.id) } }, include: { organizer: { select: ORGANIZER_SUMMARY_SELECT } } }) : [];
    const byId = new Map(events.map(event => [event.id, event]));
    const ordered = rows.flatMap(row => byId.get(row.id) ?? []);
    const items = (await this.toSummaries(ordered, now, false)).map(publicSummary);
    return { ...(query.includeRemaining ? { matchingTotal: matching } : {}), items: await this.localizeSummaries(items, query.locale), page: query.page, limit: query.limit, total, hasNext: skip + items.length < total };
  }

  private async scanList(query: CatalogQuery, prepared: Awaited<ReturnType<PublicEventsService["prepareList"]>>, now: Date): Promise<PublicEventList> {
    const { current, where, search } = prepared;
    // These modes need live inventory or event-local date evaluation before
    // sorting/filtering. Scan in bounded chunks; never silently truncate totals.
    const structuralMatches = query.includeRemaining
      ? new Set((await this.database.event.findMany({ where, select: { id: true } })).map(event => event.id)) : null;
    const candidateWhere = query.includeRemaining ? { ...publicEventWhere, AND: [current] } : where;
    const candidateCount = await this.database.event.count({ where: candidateWhere });
    let summaries: RankedSummary[] = [];
    for (let skip = 0; skip < candidateCount; skip += 100) {
      const events = await this.database.event.findMany({
        where: candidateWhere,
        orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
        skip,
        take: 100,
        include: { organizer: { select: ORGANIZER_SUMMARY_SELECT } },
      });
      summaries.push(...await this.toSummaries(events, now, query.sort === "popular"));
    }
    const allCandidates = summaries;
    if (structuralMatches) summaries = summaries.filter(event => structuralMatches.has(event.id));
    if (!query.from && !query.to && query.datePreset) {
      summaries = summaries.filter((summary) => matchesDatePreset(summary, query.datePreset!, now));
    }
    if (query.free === true) summaries = summaries.filter((summary) => summary.startingPrices.some((price) => price.amount === 0));
    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      summaries = summaries.filter((summary) => summary.startingPrices.some((price) =>
        price.currency === "KZT" &&
        (query.minPrice === undefined || price.amount >= query.minPrice * 100) &&
        (query.maxPrice === undefined || price.amount <= query.maxPrice * 100),
      ));
    }
    // Search must match the text that the visitor will actually see. A stale
    // machine translation can still exist in the database for organizer review,
    // but it must not make an unrelated fallback result appear in search.
    if (search) {
      const localized = await this.localizeSummaries(summaries, query.locale);
      const needle = search.toLocaleLowerCase();
      const visibleIds = new Set(localized.filter((item) =>
        [item.title, item.address, item.city]
          .some((value) => value?.toLocaleLowerCase().includes(needle)),
      ).map((item) => item.id));
      summaries = summaries.filter((item) => visibleIds.has(item.id));
    }
    if (query.sort === "popular") {
      summaries.sort((left, right) => {
        const popularity = right.popularity - left.popularity;
        return popularity || right.publishedAt.localeCompare(left.publishedAt) || left.id.localeCompare(right.id);
      });
    }
    if (query.sort === "soonest") summaries.sort(chronological);
    if (query.timeOfDay) summaries = summaries.filter(event => matchesEventTimeOfDay(event.time, query.timeOfDay!));
    const matchingTotal = summaries.length;
    if (query.includeRemaining) {
      const matchingIds = new Set(summaries.map(event => event.id));
      summaries = [...summaries, ...allCandidates.filter(event => !matchingIds.has(event.id)).sort(chronological)];
    }
    const skip = (query.page - 1) * query.limit;
    const items = summaries.slice(skip, skip + query.limit).map(publicSummary);
    return { ...(query.includeRemaining ? { matchingTotal } : {}), items: await this.localizeSummaries(items, query.locale), page: query.page, limit: query.limit, total: summaries.length, hasNext: skip + items.length < summaries.length };
  }

  async summary(id: string, now = new Date(), locale?: string): Promise<PublicEventSummary | null> {
    const event = await this.database.event.findFirst({
      where: { id, ...publicEventWhere },
      include: { organizer: { select: ORGANIZER_SUMMARY_SELECT } },
    });
    if (!event) return null;
    const [summary] = (await this.toSummaries([event], now, false)).map(publicSummary);
    return (await this.localizeSummaries([summary!], locale))[0] ?? null;
  }

  /** Summaries for several public events in the given order (missing or hidden ones are skipped), with page-level batching. */
  async summaries(ids: string[], now = new Date(), locale?: string): Promise<PublicEventSummary[]> {
    if (!ids.length) return [];
    const events = await this.database.event.findMany({
      where: { id: { in: ids }, ...publicEventWhere },
      include: { organizer: { select: ORGANIZER_SUMMARY_SELECT } },
    });
    const position = new Map(ids.map((id, index) => [id, index]));
    events.sort((left, right) => position.get(left.id)! - position.get(right.id)!);
    const summaries = (await this.toSummaries(events, now, false)).map(publicSummary);
    return this.localizeSummaries(summaries, locale);
  }

  async get(id: string, now = new Date(), locale?: string): Promise<PublicEvent> { return this.read(id, now, locale, false); }
  /** Called only by the staff preview endpoint, never from public query parameters. */
  async preview(id: string, locale?: string): Promise<PublicEvent> { return this.read(id, new Date(), locale, true); }
  private async read(id: string, now: Date, locale: string | undefined, preview: boolean): Promise<PublicEvent> {
    const event = await this.database.event.findFirst({
      where: { id, ...(!preview ? publicEventWhere : {}) },
      include: { organizer: { select: { organizerVerifiedAt:true, blockedAt:true, name: true, photoUrl: true, email: true, phone: true, organizerProfile: { select: { organizationName: true, address: true, showContactInfo: true } } } } },
    });
    if (!event) throw new NotFoundException({ code: "EVENT_NOT_FOUND", message: "Event was not found" });
    const serialized = await this.serialize(event, now, preview);
    const requested = normalizeLocale(locale);
    const normalized=await normalizedPresentation(this.database,event,requested);
    if(normalized)return {...serialized,...normalized.fields,ticketTypes:normalized.localizedTickets(serialized.ticketTypes),tables:normalized.localizedTables(serialized.tables)};
    const candidate = requested === event.sourceLocale ? null : await this.database.eventTranslation.findUnique({
      where: { eventId_locale: { eventId: id, locale: requested } },
    });
    const translation = candidate && (candidate.origin === "manual" || candidate.sourceHash === eventContentHash(eventContent(event))) ? candidate : null;
    return {
      ...serialized,
      ...(translation ? localizedFields(translation) : {}),
      city: localizedCity(event.city, requested),
      ticketTypes: localizedTicketTypes(serialized.ticketTypes, requested),
      tables: localizedTables(serialized.tables, requested),
      contentLocale: translation ? requested : event.sourceLocale as EventLocale,
      sourceLocale: event.sourceLocale as EventLocale,
    };
  }

  private async localizeSummaries(items: PublicEventSummary[], locale?: string): Promise<PublicEventSummary[]> {
    if (!items.length) return items;
    const requested = normalizeLocale(locale);
    const ids = items.map((item) => item.id);
    const [events, translations] = await Promise.all([
      this.database.event.findMany({ where: { id: { in: ids } } }),
      this.database.eventTranslation.findMany({ where: { eventId: { in: ids }, locale: requested } }),
    ]);
    const sources = new Map(events.map((event) => [event.id, event]));
    const localized = new Map(translations.map((translation) => [translation.eventId, translation]));
    const normalizedFields = await normalizedPresentationFields(this.database, events, requested);
    return items.map((item) => {
      const source = sources.get(item.id);
      const normalized = normalizedFields.get(item.id);
      if (normalized) return {...item,...normalized};
      const sourceLocale = source?.sourceLocale as EventLocale | undefined ?? "ru";
      const candidate = requested === sourceLocale ? null : localized.get(item.id);
      const translation = candidate && source && (candidate.origin === "manual" || candidate.sourceHash === eventContentHash(eventContent(source))) ? candidate : null;
      return {
        ...item,
        ...(translation ? { title: translation.title, address: translation.address } : {}),
        city: localizedCity(item.city, requested),
        contentLocale: translation ? requested : sourceLocale,
        sourceLocale,
      };
    });
  }

  private async serialize(
    event: Prisma.EventGetPayload<{ include: { organizer: { select: { organizerVerifiedAt:true; blockedAt:true; name: true; photoUrl: true; email: true; phone: true; organizerProfile: { select: { organizationName: true; address: true; showContactInfo: true } } } } } }>,
    now: Date,
    preview = false,
  ): Promise<PublicEvent> {
    event = { ...event, ...await eventV2CompatibilityRead(this.database, event) };
    const date = event.date.toISOString().slice(0, 10);
    const time = event.time.toISOString().slice(11, 16);
    const [ticketTypes, tables] = await Promise.all([
      this.ticketTypes.publicForEvent(event.id, now, preview),
      this.tables.publicForEvent(event.id, preview),
    ]);
    return {
      id: event.id,
      salesPaused: event.salesPaused || event.moderationStatus === "sales_paused",
      title: event.title,
      category: event.category,
      city: event.city,
      countryCode: event.countryCode,
      posterUrl: event.posterUrl,
      galleryUrls: event.galleryUrls,
      description: event.description,
      program: event.program,
      rules: event.rules,
      visitTerms: event.visitTerms,
      cancellationTerms: event.cancellationTerms,
      paymentMode: event.paymentMode,
      showFullAmountForDeposit: event.showFullAmountForDeposit,
      depositTerms: event.depositTerms,
      extraConditions: event.extraConditions,
      date,
      time,
      timezone: event.timezone,
      ageRestriction: event.ageRestriction as PublicEvent["ageRestriction"],
      startsAt: event.startsAt?.toISOString() ?? zonedInputToIso(`${date}T${time}`, event.timezone),
      endsAt: event.endsAt?.toISOString() ?? null,
      address: event.address,
      ticketTypes,
      tables,
      organizer: {
        verified:!!event.organizer.organizerVerifiedAt&&!event.organizer.blockedAt,
        name: event.organizer.organizerProfile?.organizationName ?? event.organizer.name,
        personName: event.organizer.organizerProfile?.showContactInfo ? event.organizer.name : null,
        photoUrl: event.organizer.organizerProfile?.showContactInfo ? event.organizer.photoUrl : null,
        contact: event.organizer.organizerProfile?.showContactInfo
          ? [event.organizer.phone, event.organizer.email, event.organizer.organizerProfile.address].filter(Boolean).join(" · ") || null
          : null,
      },
    };
  }

  /**
   * Card summaries for a batch of events with a fixed number of queries,
   * independent of how many events, seats or sold tickets there are.
   */
  private async toSummaries(events: CatalogEvent[], now: Date, withPopularity: boolean): Promise<RankedSummary[]> {
    if (!events.length) return [];
    const ids = events.map(event => event.id);
    const [ticketTypes, tables, allTypes, layouts, seatGroups, heldIds, sold] = await Promise.all([
      this.ticketTypes.publicForEvents(ids, now),
      this.tables.publicForEvents(ids),
      this.database.ticketType.findMany({
        where: { eventId: { in: ids }, isInternal: false },
        select: { id: true, eventId: true, price: true, deposit: true, currency: true, salesStartAt: true, salesEndAt: true },
      }),
      this.database.venueLayout.findMany({ where: { eventId: { in: ids } }, select: { id: true, eventId: true } }),
      this.database.seat.groupBy({
        by: ["venueLayoutId", "ticketTypeId"],
        where: {
          venueLayout: { eventId: { in: ids } },
          status: "available",
          ticketType: { status: "active", eventId: { in: ids } },
          allocations: { none: { status: { in: ["active", "consumed"] } } },
          OR: [{ tableId: null }, { table: { saleMode: "per_seat" } }],
        },
        _count: { _all: true },
      }),
      this.eventsWithActiveHolds(ids, now),
      withPopularity ? this.database.ticket.groupBy({
        by: ["ticketTypeId"],
        where: { status: { in: [TicketStatus.paid, TicketStatus.active, TicketStatus.used] }, ticketType: { eventId: { in: ids }, isInternal: false } },
        _count: { _all: true },
      }) : Promise.resolve([]),
    ]);
    const typeById = new Map(allTypes.map(type => [type.id, type]));
    const layoutEvent = new Map(layouts.map(layout => [layout.id, layout.eventId]));
    const seatsByEvent = new Map<string, SeatCandidateGroup[]>();
    for (const group of seatGroups) {
      const type = group.ticketTypeId ? typeById.get(group.ticketTypeId) : undefined;
      const eventId = layoutEvent.get(group.venueLayoutId);
      if (!type || !eventId || type.eventId !== eventId) continue;
      seatsByEvent.set(eventId, [...seatsByEvent.get(eventId) ?? [], { ticketType: type, count: group._count._all }]);
    }
    const popularity = new Map<string, number>();
    for (const row of sold) {
      const eventId = typeById.get(row.ticketTypeId)?.eventId;
      if (eventId) popularity.set(eventId, (popularity.get(eventId) ?? 0) + row._count._all);
    }
    return events.map(event => presentSummary(event, {
      ticketTypes: ticketTypes.get(event.id) ?? [],
      tables: tables.get(event.id) ?? [],
      seatGroups: seatsByEvent.get(event.id) ?? [],
      hasActiveHolds: heldIds.has(event.id),
      popularity: popularity.get(event.id) ?? 0,
    }, now));
  }

  /** Events with an unexpired ticket reservation, pending seat allocation or whole-table hold. */
  private async eventsWithActiveHolds(ids: string[], now: Date): Promise<Set<string>> {
    const rows = await this.database.$queryRaw<Array<{ id: string }>>`
      SELECT e.id::text AS id FROM "Event" e WHERE e.id = ANY(${ids}::uuid[]) AND (
        EXISTS (SELECT 1 FROM "TicketReservation" r JOIN "TicketType" t ON t.id = r."ticketTypeId" LEFT JOIN "Order" ro ON ro.id = r."orderId"
          WHERE t."eventId" = e.id AND NOT t."isInternal" AND r.status = 'active' AND r."expiresAt" > ${now}
            AND (r."orderId" IS NULL OR ro."paymentStatus" = 'pending'))
        OR EXISTS (SELECT 1 FROM "SeatAllocation" a JOIN "Seat" s ON s.id = a."seatId" JOIN "VenueLayout" sl ON sl.id = s."venueLayoutId" JOIN "Order" ao ON ao.id = a."orderId"
          WHERE sl."eventId" = e.id AND s.status = 'available' AND a.status = 'active' AND ao."paymentStatus" = 'pending')
        OR EXISTS (SELECT 1 FROM "Table" tb JOIN "VenueLayout" tl ON tl.id = tb."venueLayoutId"
          WHERE tl."eventId" = e.id AND tb."saleMode" = 'whole_table' AND tb.status = 'held' AND tb."holdExpiresAt" > ${now})
      )`;
    return new Set(rows.map(row => row.id));
  }
}

type CatalogQuery = {
  locale?: EventLocale;
  page: number;
  limit: number;
  sort: "recent" | "popular" | "soonest";
  includeRemaining?: boolean;
  timeOfDay?: "morning" | "day" | "evening" | "night";
  search?: string;
  from?: string;
  to?: string;
  city?: string;
  countryCode?: string;
  category?: EventCategory;
  datePreset?: "today" | "weekend";
  free?: boolean;
  minPrice?: number;
  maxPrice?: number;
};

const ORGANIZER_SUMMARY_SELECT = { organizerVerifiedAt: true, blockedAt: true, name: true, photoUrl: true } as const;
type CatalogEvent = Prisma.EventGetPayload<{ include: { organizer: { select: typeof ORGANIZER_SUMMARY_SELECT } } }>;
type RankedSummary = PublicEventSummary & { popularity: number; publishedAt: string };
type SalesWindow = { price: number; deposit: number; currency: string; salesStartAt: Date | null; salesEndAt: Date | null };
type SeatCandidateGroup = { ticketType: SalesWindow; count: number };

function publicSummary({ popularity: _popularity, publishedAt: _publishedAt, ...summary }: RankedSummary): PublicEventSummary {
  return summary;
}

/** Structural catalogue filters (city, country, category, local date) as SQL, mirroring `prepareList`. */
function structuralMatchSql(query: CatalogQuery): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (query.city?.trim()) {
    const cities = cityAliases(query.city, query.countryCode).map(city => Prisma.sql`e.city ILIKE ${`%${city.replace(/[\\%_]/g, "\\$&")}%`}`);
    parts.push(Prisma.sql`(${Prisma.join(cities, " OR ")})`);
  }
  if (query.countryCode) parts.push(Prisma.sql`e."countryCode" = ${query.countryCode}`);
  if (query.category) parts.push(Prisma.sql`e.category = ${query.category}::"EventCategory"`);
  if (query.from) parts.push(Prisma.sql`e."date" >= ${query.from}::date`);
  if (query.to) parts.push(Prisma.sql`e."date" <= ${query.to}::date`);
  return parts.length ? Prisma.sql`(${Prisma.join(parts, " AND ")})` : Prisma.sql`TRUE`;
}

function presentSummary(event: CatalogEvent, inventory: {
  ticketTypes: PublicTicketType[];
  tables: PublicTable[];
  seatGroups: SeatCandidateGroup[];
  hasActiveHolds: boolean;
  popularity: number;
}, now: Date): RankedSummary {
  const { ticketTypes, tables, seatGroups } = inventory;
  const date = formatDate(event.date);
  const time = formatTime(event.time);
  const candidateSeats = seatGroups.reduce((sum, group) => sum + group.count, 0);
  const openSeatGroups = seatGroups.filter((group) => isInSalesWindow(group.ticketType, now));
  const remainingSeats = openSeatGroups.reduce((sum, group) => sum + group.count, 0);
  const options = [
    ...ticketTypes.filter((ticket) => ticket.remaining > 0).map((ticket) => ({ amount: ticket.payment.amountDue, fullAmount: ticket.payment.fullAmount, currency: ticket.payment.currency, unit: "ticket" as const })),
    ...tables.filter((table) => table.availability === "available" && table.saleMode === "whole_table").map((table) => ({ amount: table.payment.amountDue, fullAmount: table.payment.fullAmount, currency: table.payment.currency, unit: "table" as const })),
    ...openSeatGroups.map(({ ticketType }) => ({
      amount: event.paymentMode === "deposit" ? ticketType.deposit : ticketType.price,
      fullAmount: event.paymentMode === "deposit" && !event.showFullAmountForDeposit ? null : ticketType.price,
      currency: ticketType.currency.trim(),
      unit: "seat" as const,
    })),
  ];
  const startingPrices = [...new Set(options.map((option) => option.currency))].sort().map((currency) =>
    options.filter((option) => option.currency === currency).sort((left, right) => left.amount - right.amount)[0]!,
  );
  const singleCurrency = startingPrices.length === 1 ? startingPrices[0] : null;
  const futureSeats = candidateSeats > remainingSeats && seatGroups.some(({ ticketType }) => ticketType.salesStartAt && ticketType.salesStartAt > now);
  const endedSeats = candidateSeats > remainingSeats && seatGroups.every(({ ticketType }) => ticketType.salesEndAt && ticketType.salesEndAt <= now);
  return {
    id: event.id,
    title: event.title,
    category: event.category,
    city: event.city,
    countryCode: event.countryCode,
    posterUrl: event.posterUrl,
    date,
    time,
    timezone: event.timezone,
    ageRestriction: event.ageRestriction as PublicEventSummary["ageRestriction"],
    startsAt: event.startsAt?.toISOString() ?? zonedInputToIso(`${date}T${time}`, event.timezone),
    endsAt: event.endsAt?.toISOString() ?? null,
    address: event.address,
    paymentMode: event.paymentMode,
    paymentLabel: event.paymentMode,
    startingAmount: singleCurrency?.amount ?? null,
    startingFullAmount: singleCurrency?.fullAmount ?? null,
    startingCurrency: singleCurrency?.currency ?? null,
    startingUnit: singleCurrency?.unit ?? null,
    startingPrices,
    remainingTickets: ticketTypes.reduce((sum, ticket) => sum + ticket.remaining, 0),
    remainingTables: tables.filter((table) => table.availability === "available" && table.saleMode === "whole_table").length,
    remainingSeats,
    saleStatus: hasEventEnded(guestEventTiming(event), now) ? "sales_ended" : event.paymentMode === "deposit" ? "temporarily_unavailable" : saleStatus(ticketTypes, tables, remainingSeats, futureSeats, endedSeats, inventory.hasActiveHolds, now),
    organizer: { verified:!!event.organizer.organizerVerifiedAt&&!event.organizer.blockedAt, name: event.organizer.name, photoUrl: event.organizer.photoUrl },
    popularity: inventory.popularity,
    publishedAt: (event.publishedAt ?? event.updatedAt).toISOString(),
  };
}

function saleStatus(
  ticketTypes: Array<{ remaining: number; salesStartAt: string | null; salesEndAt: string | null }>,
  tables: Array<{ availability: string; saleMode: string }>,
  remainingSeats: number,
  futureSeats: boolean,
  endedSeats: boolean,
  hasActiveHolds: boolean,
  now: Date,
): PublicSaleStatus {
  const remaining = ticketTypes.reduce((sum, ticket) => sum + ticket.remaining, 0)
    + tables.filter((table) => table.availability === "available" && table.saleMode === "whole_table").length + remainingSeats;
  if (remaining > 0) return remaining <= 5 ? "few_left" : "available";
  if (hasActiveHolds) return "temporarily_unavailable";
  const hasFutureSales = futureSeats || ticketTypes.some((ticket) => ticket.salesStartAt && new Date(ticket.salesStartAt) > now);
  if (hasFutureSales) return "sales_not_started";
  const hasSalesWindows = ticketTypes.length > 0;
  const allSalesEnded = hasSalesWindows && ticketTypes.every((ticket) => ticket.salesEndAt && new Date(ticket.salesEndAt) <= now);
  return (allSalesEnded || (ticketTypes.length === 0 && endedSeats)) ? "sales_ended" : "sold_out";
}

function isInSalesWindow(ticketType: { salesStartAt: Date | null; salesEndAt: Date | null } | null, now: Date): boolean {
  return Boolean(ticketType && (!ticketType.salesStartAt || ticketType.salesStartAt <= now) && (!ticketType.salesEndAt || ticketType.salesEndAt > now));
}

function matchesDatePreset(summary: PublicEventSummary, preset: "today" | "weekend", now: Date): boolean {
  const eventLocalDate = summary.date;
  const today = localDate(now, summary.timezone);
  if (preset === "today") return eventLocalDate === today;
  return ["Sat", "Sun"].includes(localWeekday(eventLocalDate, summary.timezone));
}

function localDate(value: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function localWeekday(date: string, timezone: string): string {
  // Interpret the date in the event's timezone before asking Intl for its weekday.
  // Using a UTC noon here changes the calendar day for positive/negative offsets.
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(new Date(zonedInputToIso(`${date}T12:00`, timezone)));
  } catch {
    return "";
  }
}

function formatDate(value: Date): string {
  return `${value.getUTCFullYear().toString().padStart(4, "0")}-${(value.getUTCMonth() + 1).toString().padStart(2, "0")}-${value.getUTCDate().toString().padStart(2, "0")}`;
}

function formatTime(value: Date): string {
  return `${value.getUTCHours().toString().padStart(2, "0")}:${value.getUTCMinutes().toString().padStart(2, "0")}`;
}

function dateAtUtcStart(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function dateAtUtcEnd(value: string): Date {
  return new Date(`${value}T23:59:59.999Z`);
}

function validateDateRange(from: string | undefined, to: string | undefined): void {
  for (const value of [from, to]) {
    if (!value) continue;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw new BadRequestException({ code: "EVENT_DATE_FILTER_INVALID", message: "Date filters are invalid" });
    }
  }
  if (from && to && from > to) {
    throw new BadRequestException({ code: "EVENT_DATE_FILTER_RANGE_INVALID", message: "The start date must not be after the end date" });
  }
}

function chronological(left: PublicEventSummary, right: PublicEventSummary): number {
  return Date.parse(left.startsAt) - Date.parse(right.startsAt) || left.id.localeCompare(right.id);
}
