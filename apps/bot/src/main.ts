import { loadBotEnv } from "@event-platform/config";
import express, { type NextFunction, type Request, type Response } from "express";

import { createBot } from "./bot.js";
import { handleTelegramWebhook } from "./webhook-handler.js";

const env = loadBotEnv();
if (!env.TELEGRAM_WEBHOOK_SECRET) throw new Error("TELEGRAM_WEBHOOK_SECRET must be configured separately from BOT_API_SECRET");
const bot = createBot(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_BOT_USERNAME, {
  apiBaseUrl: env.API_BASE_URL, botApiSecret: env.BOT_API_SECRET, messagesEnabled: env.TELEGRAM_BOT_MESSAGES_ENABLED,
  ...(env.WEB_ORIGIN ? { webOrigin: env.WEB_ORIGIN } : {}),
  ...(env.TELEGRAM_SEAT_MINI_APP_ENABLED ? { seatMiniAppName: env.TELEGRAM_SEAT_MINI_APP_NAME } : {}),
});
const botId = env.TELEGRAM_BOT_TOKEN.split(":")[0] ?? env.TELEGRAM_BOT_USERNAME;
const inFlight = new Set<Promise<void>>();
const app = express();

app.get("/health", (_request, response) => { response.status(200).json({ status: "ok" }); });

// Keep the exact raw bytes for the inbox hash and reject unauthenticated updates before grammY.
// The update is acknowledged after the inbox claim and handled in the background.
app.post("/telegram/webhook", express.raw({ type: "application/json", limit: "256kb" }), async (request, response, next) => {
  try {
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.from("");
    const result = await handleTelegramWebhook(request.header("x-telegram-bot-api-secret-token"), raw, {
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET!, botApiSecret: env.BOT_API_SECRET, apiBaseUrl: env.API_BASE_URL, botId, fetch,
      handleUpdate: (update) => bot.handleUpdate(update as Parameters<typeof bot.handleUpdate>[0]),
      logError: (message) => { console.error(message); },
    });
    if (result.processing) {
      const tracked = result.processing.finally(() => { inFlight.delete(tracked); });
      inFlight.add(tracked);
    }
    response.status(result.status).json(result.body);
  } catch (error) { next(error); }
});

app.use(express.json());
app.use((_error: unknown, _request: Request, response: Response, _next: NextFunction) => { console.error("Telegram webhook failed"); response.status(500).json({ status: "error" }); });

const server = app.listen(env.BOT_PORT, "0.0.0.0", () => { console.log(`Telegram webhook listening on http://localhost:${env.BOT_PORT}/telegram/webhook`); });
function shutdown(): void {
  server.close((error) => {
    if (error) { console.error("Bot server shutdown failed", error); process.exitCode = 1; }
    // Let acknowledged updates finish and record their inbox outcome before exit.
    void Promise.allSettled(inFlight);
  });
}
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
