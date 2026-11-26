import type { BotGuestSettings, EventCategory, EventLocale, PublicSaleStatus } from "@event-platform/shared-types";
import type { Context } from "grammy";

export type GuestContext = Context & { guestSettings?: BotGuestSettings };

export function guestLocale(ctx: GuestContext): EventLocale {
  const language = ctx.guestSettings?.locale ?? ctx.from?.language_code?.toLowerCase().split("-")[0];
  return language === "en" || language === "kk" ? language : "ru";
}

export const guestCopy = {
  en: {
    home: "🏠 Menu", find: "🎭 Find events", tickets: "🎟 My tickets", messages: "💬 Messages", profile: "⚙️ Profile", organizer: "📊 Organizer",
    hello: "Hi", welcome: "Find an event, buy a ticket and keep your QR codes right here in Telegram.", welcomeAsk: "What would you like to do?",
    catalogue: "🎭 Events", private: "🔒 Open a private chat with the bot to continue.",
    back: "← Back", previous: "‹ Prev", next: "Next ›", search: "🔎 Search", searchPrompt: "🔎 Type an event name, city or address and send it as a reply.", searchLong: "⚠️ That's too long — use up to 120 characters.", clearSearch: "✖️ Clear search", reset: "✖️ Reset filters",
    city: "📍 City", allCities: "All cities", saveCity: "Home city", selectCity: "📍 <b>Choose a city</b>", selectDefaultCity: "📍 <b>Your home city</b>\nWe'll use it for every new search.",
    language: "🌐 Language", selectLanguage: "🌐 <b>Choose the bot language</b>", today: "Today", weekend: "Weekend", free: "Free", category: "🏷 Category", allCategories: "All categories",
    empty: "😕 Nothing found.\nTry another city or reset the filters.", expired: "⌛️ This menu has expired. Start a new search.", unavailable: "⚠️ Something went wrong. Please try again.",
    eventGone: "😔 This event is no longer available.", details: "ℹ️ Details", noDetails: "No extra details yet.", directions: "🗺 Directions", share: "📤 Share",
    buy: "🎟 Buy tickets", seats: "💺 Pick a seat on the map", choose: "Choose a ticket 👇", unavailableOptions: "😔 No tickets are available right now.",
    ticket: "ticket", table: "table", seat: "seat", from: "from", more: "More prices", pricePending: "Price coming soon",
    paused: "Sales paused", ended: "Event has ended", orders: "🧾 Orders", account: "👤 Ticketron account ↗", support: "🆘 Support ↗", linkAccount: "🔗 Connect account ↗",
    linkHint: "🔗 Connect your Ticketron account to get order and event notifications here.\n\nOpen your account → Sign-in methods → Telegram.", inboxInfo: "🔔 All notifications ↗", inboxEmpty: "📭 No notifications yet.",
    noToday: "You have no events today.", guestCount: "Guests", notAllowed: "Organizer access is unavailable.", noTickets: "No tickets yet.", qr: "📱 Show this QR code at the entrance.\nDon't share it with anyone.",
    languageLine: "🌐 Language", cityLine: "📍 Home city", unread: "Unread",
    status: { available: "On sale", few_left: "Few left", sold_out: "Sold out", temporarily_unavailable: "Temporarily unavailable", sales_not_started: "Sales start soon", sales_ended: "Sales ended" },
  },
  ru: {
    home: "🏠 Меню", find: "🎭 Найти событие", tickets: "🎟 Мои билеты", messages: "💬 Сообщения", profile: "⚙️ Профиль", organizer: "📊 Организатор",
    hello: "Привет", welcome: "Здесь можно найти событие, купить билет и хранить QR-коды прямо в Telegram.", welcomeAsk: "Что хотите сделать?",
    catalogue: "🎭 Афиша", private: "🔒 Чтобы продолжить, откройте личный чат с ботом.",
    back: "← Назад", previous: "‹ Пред.", next: "Далее ›", search: "🔎 Поиск", searchPrompt: "🔎 Напишите название события, город или адрес и отправьте ответом.", searchLong: "⚠️ Слишком длинно — до 120 символов.", clearSearch: "✖️ Очистить поиск", reset: "✖️ Сбросить фильтры",
    city: "📍 Город", allCities: "Все города", saveCity: "Мой город", selectCity: "📍 <b>Выберите город</b>", selectDefaultCity: "📍 <b>Ваш город</b>\nОн будет подставляться в каждый новый поиск.",
    language: "🌐 Язык", selectLanguage: "🌐 <b>Выберите язык бота</b>", today: "Сегодня", weekend: "Выходные", free: "Бесплатно", category: "🏷 Категория", allCategories: "Все категории",
    empty: "😕 Ничего не нашлось.\nПопробуйте другой город или сбросьте фильтры.", expired: "⌛️ Это меню устарело. Начните поиск заново.", unavailable: "⚠️ Что-то пошло не так. Попробуйте ещё раз.",
    eventGone: "😔 Это событие больше недоступно.", details: "ℹ️ Подробнее", noDetails: "Подробностей пока нет.", directions: "🗺 Маршрут", share: "📤 Поделиться",
    buy: "🎟 Купить билет", seats: "💺 Выбрать место на схеме", choose: "Выберите билет 👇", unavailableOptions: "😔 Сейчас нет доступных билетов.",
    ticket: "билет", table: "столик", seat: "место", from: "от", more: "Другие цены", pricePending: "Цена скоро появится",
    paused: "Продажи приостановлены", ended: "Событие завершилось", orders: "🧾 Заказы", account: "👤 Аккаунт Ticketron ↗", support: "🆘 Поддержка ↗", linkAccount: "🔗 Подключить аккаунт ↗",
    linkHint: "🔗 Подключите аккаунт Ticketron, чтобы получать сюда уведомления о заказах и событиях.\n\nАккаунт → Способы входа → Telegram.", inboxInfo: "🔔 Все уведомления ↗", inboxEmpty: "📭 Уведомлений пока нет.",
    noToday: "Сегодня у вас нет событий.", guestCount: "Гостей", notAllowed: "Доступ организатора недоступен.", noTickets: "Билетов пока нет.", qr: "📱 Покажите этот QR-код на входе.\nНе пересылайте его другим.",
    languageLine: "🌐 Язык", cityLine: "📍 Мой город", unread: "Непрочитанных",
    status: { available: "В продаже", few_left: "Осталось мало", sold_out: "Распродано", temporarily_unavailable: "Временно недоступно", sales_not_started: "Продажи скоро начнутся", sales_ended: "Продажи завершены" },
  },
  kk: {
    home: "🏠 Мәзір", find: "🎭 Іс-шара табу", tickets: "🎟 Билеттерім", messages: "💬 Хабарламалар", profile: "⚙️ Профиль", organizer: "📊 Ұйымдастырушы",
    hello: "Сәлем", welcome: "Мұнда іс-шара тауып, билет сатып алып, QR-кодтарды Telegram-да сақтай аласыз.", welcomeAsk: "Не істегіңіз келеді?",
    catalogue: "🎭 Афиша", private: "🔒 Жалғастыру үшін ботпен жеке чат ашыңыз.",
    back: "← Артқа", previous: "‹ Алдыңғы", next: "Келесі ›", search: "🔎 Іздеу", searchPrompt: "🔎 Іс-шара атауын, қаланы немесе мекенжайды жауап ретінде жіберіңіз.", searchLong: "⚠️ Тым ұзын — 120 таңбаға дейін.", clearSearch: "✖️ Іздеуді тазарту", reset: "✖️ Сүзгілерді тазарту",
    city: "📍 Қала", allCities: "Барлық қала", saveCity: "Менің қалам", selectCity: "📍 <b>Қаланы таңдаңыз</b>", selectDefaultCity: "📍 <b>Сіздің қалаңыз</b>\nӘр жаңа іздеуде қолданылады.",
    language: "🌐 Тіл", selectLanguage: "🌐 <b>Бот тілін таңдаңыз</b>", today: "Бүгін", weekend: "Демалыс", free: "Тегін", category: "🏷 Санат", allCategories: "Барлық санат",
    empty: "😕 Ештеңе табылмады.\nБасқа қаланы таңдаңыз немесе сүзгілерді тазалаңыз.", expired: "⌛️ Мәзірдің мерзімі өтті. Қайта іздеңіз.", unavailable: "⚠️ Бірдеңе дұрыс болмады. Қайта көріңіз.",
    eventGone: "😔 Бұл іс-шара енді қолжетімсіз.", details: "ℹ️ Толығырақ", noDetails: "Әзірге қосымша мәлімет жоқ.", directions: "🗺 Бағыт", share: "📤 Бөлісу",
    buy: "🎟 Билет алу", seats: "💺 Сызбадан орын таңдау", choose: "Билетті таңдаңыз 👇", unavailableOptions: "😔 Қазір қолжетімді билет жоқ.",
    ticket: "билет", table: "үстел", seat: "орын", from: "бастап", more: "Басқа бағалар", pricePending: "Баға жақында шығады",
    paused: "Сатылым тоқтатылды", ended: "Іс-шара аяқталды", orders: "🧾 Тапсырыстар", account: "👤 Ticketron аккаунты ↗", support: "🆘 Қолдау ↗", linkAccount: "🔗 Аккаунтты қосу ↗",
    linkHint: "🔗 Тапсырыстар мен іс-шаралар туралы хабарландыруларды осында алу үшін Ticketron аккаунтын қосыңыз.\n\nАккаунт → Кіру тәсілдері → Telegram.", inboxInfo: "🔔 Барлық хабарландыру ↗", inboxEmpty: "📭 Әзірге хабарландыру жоқ.",
    noToday: "Бүгін іс-шараларыңыз жоқ.", guestCount: "Қонақтар", notAllowed: "Ұйымдастырушы режимі қолжетімсіз.", noTickets: "Билет әзірге жоқ.", qr: "📱 Кіреберісте осы QR-кодты көрсетіңіз.\nОны ешкімге жібермеңіз.",
    languageLine: "🌐 Тіл", cityLine: "📍 Менің қалам", unread: "Оқылмаған",
    status: { available: "Сатылымда", few_left: "Аз қалды", sold_out: "Сатылып кетті", temporarily_unavailable: "Уақытша қолжетімсіз", sales_not_started: "Сатылым жақында басталады", sales_ended: "Сатылым аяқталды" },
  },
} satisfies Record<EventLocale, { status: Record<PublicSaleStatus, string> } & Record<string, unknown>>;

export const categoryLabels: Record<EventLocale, Record<EventCategory, string>> = {
  en: { music: "Music", nightlife: "Nightlife", festival: "Festival", comedy: "Comedy", theatre: "Theatre", business: "Business", education: "Education", workshop: "Workshop", sport: "Sport", family: "Family", children: "Children", adults: "18+", cinema: "Cinema", exhibitions: "Exhibitions", excursions: "Tours", food: "Food", other: "Other" },
  ru: { music: "Музыка", nightlife: "Ночная жизнь", festival: "Фестиваль", comedy: "Комедия", theatre: "Театр", business: "Бизнес", education: "Образование", workshop: "Мастер-класс", sport: "Спорт", family: "Для семьи", children: "Детям", adults: "18+", cinema: "Кино", exhibitions: "Выставки", excursions: "Экскурсии", food: "Гастрономия", other: "Другое" },
  kk: { music: "Музыка", nightlife: "Түнгі өмір", festival: "Фестиваль", comedy: "Комедия", theatre: "Театр", business: "Бизнес", education: "Білім", workshop: "Шеберлік сабағы", sport: "Спорт", family: "Отбасы", children: "Балаларға", adults: "18+", cinema: "Кино", exhibitions: "Көрмелер", excursions: "Саяхат", food: "Тағам", other: "Басқа" },
};
