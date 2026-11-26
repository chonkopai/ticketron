import type { EventLocale, TelegramSeatOrder } from "@event-platform/shared-types";

export const copy = {
  en: {
    picker: "Choose seats", map: "Map", list: "List", loading: "Loading…", back: "Back", chat: "Open bot",
    hallMap: "Hall map", mapZoom: "Map zoom", zoomIn: "Zoom in", zoomOut: "Zoom out", zoomReset: "Reset zoom",
    row: "Row", table: "Table", seat: "Seat", available: "Available", seatAvailable: "Available", seatUnavailable: "Unavailable", seatSelected: "Selected",
    unavailable: "Seats are unavailable for this event.", soldOut: "No seats or tables are available.", launch: "Open the seat picker from Ticketron’s private Telegram chat.",
    relaunch: "This session ended. Reopen the seat picker from the bot.", offerLimit: "Too many open offers. Finish or wait a few minutes before starting a new one.", restricted: "Purchases are unavailable for this account.",
    error: "Couldn’t load this screen. Try again.", eventGone: "This event is unavailable.", retry: "Try again",
    changed: "Availability, prices or terms changed. Review your choices again.", currencies: "Choose seats in the same currency.", limit: "You can choose up to 10 seats.",
    amountLimit: "Choose fewer items to stay within the order amount limit.",
    review: "Review selection", confirm: "Confirm order", total: "Total", selected: "Selected", terms: "Refund terms",
    noRefund: "Refunds are unavailable.", noTerms: "No refund terms are listed.", accept: "I accept the terms shown above.",
    free: "Free", chooseAgain: "Choose seats again", check: "Check status", pay: "Pay", tickets: "Open order in Telegram", held: "Hold remaining",
    demo: "Test payment. Waiting for confirmation from the test provider.", paymentUnavailable: "The payment link is unavailable. Check again shortly.",
    capacity: (count: number) => `Capacity ${count}`,
    statuses: { pending: "Awaiting payment", paid: "Order confirmed", failed: "Payment failed", cancelled: "Order cancelled", refunded: "Order refunded", expired: "Hold expired", review_required: "Payment under review" },
  },
  ru: {
    picker: "Выберите места", map: "Схема", list: "Список", loading: "Загрузка…", back: "Назад", chat: "Открыть бот",
    hallMap: "Схема зала", mapZoom: "Масштаб схемы", zoomIn: "Увеличить", zoomOut: "Уменьшить", zoomReset: "Сбросить масштаб",
    row: "Ряд", table: "Стол", seat: "Место", available: "Доступно", seatAvailable: "Доступно", seatUnavailable: "Недоступно", seatSelected: "Выбрано",
    unavailable: "Выбор мест на это событие недоступен.", soldOut: "Свободных мест и столов нет.", launch: "Откройте схему из личного чата с ботом Ticketron.",
    relaunch: "Сессия завершена. Откройте схему зала из бота ещё раз.", offerLimit: "Слишком много открытых предложений. Завершите их или подождите несколько минут.", restricted: "Покупки для этого аккаунта недоступны.",
    error: "Не удалось загрузить экран. Попробуйте ещё раз.", eventGone: "Событие недоступно.", retry: "Повторить",
    changed: "Места, цены или условия изменились. Проверьте выбор ещё раз.", currencies: "Выберите места в одной валюте.", limit: "Можно выбрать до 10 мест.",
    amountLimit: "Уменьшите количество мест, чтобы сумма не превышала лимит заказа.",
    review: "Проверить выбор", confirm: "Подтвердить заказ", total: "Итого", selected: "Выбрано", terms: "Условия возврата",
    noRefund: "Возврат недоступен.", noTerms: "Условия возврата не указаны.", accept: "Я принимаю условия, указанные выше.",
    free: "Бесплатно", chooseAgain: "Выбрать места снова", check: "Проверить статус", pay: "Оплатить", tickets: "Открыть заказ в Telegram", held: "До окончания брони",
    demo: "Тестовая оплата. Ожидаем подтверждения от тестового провайдера.", paymentUnavailable: "Ссылка для оплаты недоступна. Проверьте статус чуть позже.",
    capacity: (count: number) => `Мест за столом: ${count}`,
    statuses: { pending: "Ожидает оплаты", paid: "Заказ подтверждён", failed: "Ошибка оплаты", cancelled: "Заказ отменён", refunded: "Оплата возвращена", expired: "Срок брони истёк", review_required: "Платёж проверяется" },
  },
  kk: {
    picker: "Орын таңдаңыз", map: "Сызба", list: "Тізім", loading: "Жүктелуде…", back: "Артқа", chat: "Ботты ашу",
    hallMap: "Зал сызбасы", mapZoom: "Сызба масштабы", zoomIn: "Үлкейту", zoomOut: "Кішірейту", zoomReset: "Масштабты қалпына келтіру",
    row: "Қатар", table: "Үстел", seat: "Орын", available: "Бос", seatAvailable: "Бос", seatUnavailable: "Қолжетімсіз", seatSelected: "Таңдалды",
    unavailable: "Бұл іс-шарада орын таңдау қолжетімсіз.", soldOut: "Бос орындар мен үстелдер жоқ.", launch: "Зал сызбасын Ticketron ботымен жеке чаттан ашыңыз.",
    relaunch: "Сеанс аяқталды. Зал сызбасын боттан қайта ашыңыз.", offerLimit: "Ашық ұсыныстар тым көп. Аяқтаңыз немесе бірнеше минут күтіңіз.", restricted: "Бұл аккаунтпен сатып алу мүмкін емес.",
    error: "Экран жүктелмеді. Қайталап көріңіз.", eventGone: "Іс-шара қолжетімсіз.", retry: "Қайталау",
    changed: "Бос орындар, баға немесе шарттар өзгерді. Таңдауыңызды қайта тексеріңіз.", currencies: "Бағасы бір валютадағы орындарды таңдаңыз.", limit: "10 орынға дейін таңдауға болады.",
    amountLimit: "Тапсырыс сомасы шектен аспауы үшін таңдауды азайтыңыз.",
    review: "Таңдауды тексеру", confirm: "Тапсырысты растау", total: "Жиыны", selected: "Таңдалды", terms: "Қайтару шарттары",
    noRefund: "Қайтару мүмкін емес.", noTerms: "Қайтару шарттары көрсетілмеген.", accept: "Жоғарыдағы шарттарды қабылдаймын.",
    free: "Тегін", chooseAgain: "Орынды қайта таңдау", check: "Мәртебені тексеру", pay: "Төлеу", tickets: "Тапсырысты Telegram-да ашу", held: "Броньның аяқталуына дейін",
    demo: "Сынақ төлемі. Сынақ провайдерінің растауын күтеміз.", paymentUnavailable: "Төлем сілтемесі қолжетімсіз. Мәртебені кейінірек тексеріңіз.",
    capacity: (count: number) => `Сыйымдылығы: ${count} орын`,
    statuses: { pending: "Төлем күтілуде", paid: "Тапсырыс расталды", failed: "Төлем өтпеді", cancelled: "Тапсырыс жойылды", refunded: "Төлем қайтарылды", expired: "Бронь мерзімі өтті", review_required: "Төлем тексерілуде" },
  },
} satisfies Record<EventLocale, { statuses: Record<TelegramSeatOrder["status"], string>; [key: string]: unknown }>;

export type SeatCopy = (typeof copy)[EventLocale];

export function seatLocale(value?: string): EventLocale {
  const lang = value?.toLowerCase().split("-")[0];
  return lang === "en" || lang === "kk" ? lang : "ru";
}
