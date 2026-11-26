import { TELEGRAM_ALLOWED_UPDATES } from "./webhook.js";
import { loadBotEnv } from "@event-platform/config";

const env = loadBotEnv();
if (!env.TELEGRAM_WEBHOOK_SECRET) throw new Error("TELEGRAM_WEBHOOK_SECRET must be configured separately from BOT_API_SECRET");
const origin = process.env.WEB_ORIGIN;
if (!origin || new URL(origin).protocol !== "https:") throw new Error("WEB_ORIGIN must be the public HTTPS website URL");
const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ url: new URL("/telegram/webhook", origin).toString(), secret_token: env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: TELEGRAM_ALLOWED_UPDATES, drop_pending_updates: false }),
});
const result = await response.json() as { ok?: boolean };
if (!result.ok) throw new Error("Telegram webhook registration failed");
console.log("Telegram webhook registered with secret verification. No updates were discarded.");

const commands = {
  en: { menu: "🏠 Main menu", events: "🎭 Find events", tickets: "🎟 My tickets & QR codes", chat: "💬 Messages", check_payment: "💳 Payment status", help: "ℹ️ Help" },
  ru: { menu: "🏠 Главное меню", events: "🎭 Афиша событий", tickets: "🎟 Мои билеты и QR-коды", chat: "💬 Сообщения", check_payment: "💳 Статус оплаты", help: "ℹ️ Помощь" },
  kk: { menu: "🏠 Басты мәзір", events: "🎭 Іс-шаралар афишасы", tickets: "🎟 Билеттерім және QR-кодтар", chat: "💬 Хабарламалар", check_payment: "💳 Төлем күйі", help: "ℹ️ Көмек" },
};
// Russian is the default menu; English and Kazakh Telegram clients get their own language.
for (const [language, labels] of [["", commands.ru], ["ru", commands.ru], ["en", commands.en], ["kk", commands.kk]] as const) {
  const list = Object.entries(labels)
    .filter(([command]) => env.TELEGRAM_BOT_MESSAGES_ENABLED || command !== "chat")
    .map(([command, description]) => ({ command, description }));
  const menu = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMyCommands`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: { type: "all_private_chats" }, commands: list, ...(language ? { language_code: language } : {}) }),
  });
  if (!(await menu.json() as { ok?: boolean }).ok) throw new Error(`Telegram private command menu registration failed (${language || "default"})`);
}
console.log("Telegram private command menu registered (default, ru, en, kk).");
