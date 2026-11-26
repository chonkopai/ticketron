import { loadWebEnv } from "@event-platform/config";
import type { NextConfig } from "next";

loadWebEnv();

const apiBaseUrl = process.env.API_INTERNAL_URL ?? "http://localhost:3001";
const botBaseUrl = process.env.BOT_INTERNAL_URL ?? "http://localhost:3002";

/**
 * Content Security Policy, sent as Report-Only: browsers log violations to the console but block
 * nothing. See docs/deployment.md ("Content Security Policy") for switching to enforcement.
 */
function contentSecurityPolicy(scope: "site" | "admin"): string {
  const dev = process.env.NODE_ENV === "development";
  let apiOrigin = "";
  try { apiOrigin = process.env.NEXT_PUBLIC_API_URL ? new URL(process.env.NEXT_PUBLIC_API_URL).origin : ""; } catch { apiOrigin = ""; }
  const self = ["'self'", apiOrigin].filter(Boolean).join(" ");
  // Telegram login widget, Google sign-in, Yandex Maps (script, tiles, suggest) and the Google Maps embed.
  const yandex = "https://*.yandex.ru https://*.yandex.net https://*.yandex.com https://yastatic.net";
  const site = {
    "script-src": `'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""} https://telegram.org https://accounts.google.com ${yandex}`,
    "style-src": `'self' 'unsafe-inline' https://accounts.google.com ${yandex}`,
    "img-src": `${self} blob: data: https://telegram.org https://t.me https://*.telegram.org https://*.googleusercontent.com ${yandex}`,
    "media-src": `${self} blob:`,
    "font-src": "'self' data:",
    "connect-src": `${self}${dev ? " ws:" : ""} https://accounts.google.com ${yandex}`,
    "frame-src": "https://oauth.telegram.org https://accounts.google.com https://www.google.com https://yandex.ru https://yandex.com",
    "frame-ancestors": "'none'",
  };
  const admin = {
    "script-src": `'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src": "'self' 'unsafe-inline'",
    "img-src": `${self} blob: data:`,
    "media-src": `${self} blob:`,
    "font-src": "'self' data:",
    "connect-src": `${self}${dev ? " ws:" : ""}`,
    "frame-src": "'none'",
    "frame-ancestors": "'none'",
  };
  const directives = { "default-src": "'self'", ...(scope === "admin" ? admin : site), "object-src": "'none'", "base-uri": "'self'", "form-action": "'self'" };
  return Object.entries(directives).map(([name, value]) => `${name} ${value}`).join("; ");
}

const nextConfig: NextConfig = {
  distDir: process.env.TICKET_NEXT_DIST_DIR ?? ".next",
  allowedDevOrigins: ["admin.localhost", ...(process.env.NEXT_ALLOWED_DEV_ORIGINS ?? "").split(",").map(origin => origin.trim()).filter(Boolean)],
  reactStrictMode: true,
  env: { NEXT_PUBLIC_YANDEX_GEOCODER_ENABLED: process.env.YANDEX_GEOCODER_API_KEY?.trim() || process.env.NEXT_PUBLIC_YANDEX_GEOCODER_ENABLED === "true" ? "true" : "false" },
  transpilePackages: ["@event-platform/config", "@event-platform/shared-types"],
  async headers() {
    return [{ source: "/:path*", headers: [{ key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" }] },
      // Public site: every path except the staff console, which gets the stricter admin policy below.
      { source: "/((?!admin(?:/|$)|staff-api(?:/|$)).*)", headers: [{ key: "Content-Security-Policy-Report-Only", value: contentSecurityPolicy("site") }] },
      { source: "/admin/:path*", headers: [{ key: "Content-Security-Policy-Report-Only", value: contentSecurityPolicy("admin") }] },
      { source: "/admin", headers: [{ key: "Content-Security-Policy-Report-Only", value: contentSecurityPolicy("admin") }] }, { source: "/login/telegram/callback", headers: [{ key: "Cache-Control", value: "no-store" }, { key: "Referrer-Policy", value: "no-referrer" }, { key: "X-Robots-Tag", value: "noindex, nofollow" }] }, { source: "/delivery", headers: [{ key: "Cache-Control", value: "no-store" }, { key: "Referrer-Policy", value: "no-referrer" }, { key: "X-Robots-Tag", value: "noindex, nofollow" }] }];
  },
  async rewrites() {
    return [
      { source: "/ticket-email/:path*", destination: `${apiBaseUrl}/ticket-email/:path*` },
      { source: "/platform-support/:path*", destination: `${apiBaseUrl}/platform-support/:path*` },
      { source: "/api/creation-drafts/:path*", destination: `${apiBaseUrl}/creation-drafts/:path*` },
      { source: "/api/quick/:path*", destination: `${apiBaseUrl}/quick/:path*` },
      { source: "/orders/:path*", destination: `${apiBaseUrl}/orders/:path*` },
      {
        source: "/auth/:path*",
        destination: `${apiBaseUrl}/auth/:path*`,
      },
      {
        source: "/me",
        destination: `${apiBaseUrl}/me`,
      },
      {
        source: "/me/:path*",
        destination: `${apiBaseUrl}/me/:path*`,
      },
      {
        source: "/api/health",
        destination: `${apiBaseUrl}/health`,
      },
      {
        source: "/api/organizer/:path*",
        destination: `${apiBaseUrl}/organizer/:path*`,
      },
      {
        source: "/api/events/:path*",
        destination: `${apiBaseUrl}/events/:path*`,
      },
      {
        source: "/media/:path*",
        destination: `${apiBaseUrl}/media/:path*`,
      },
      {
        source: "/telegram/webhook",
        destination: `${botBaseUrl}/telegram/webhook`,
      },
    ];
  },
};

export default nextConfig;
