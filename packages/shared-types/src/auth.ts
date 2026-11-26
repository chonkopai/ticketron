export type UserRole = "guest" | "organizer" | "admin";
export type LoginContactMethod = "email" | "phone";

export interface VerificationRequestResponse {
  challengeId: string;
  expiresAt: string;
  retryAfterSeconds: number;
}

export interface VerificationGrantResponse {
  grant: string;
  expiresAt: string;
}

export interface LinkedMethodsResponse {
  google?: { linked: boolean; email: string | null };
  telegram: { linked: boolean; id: string | null };
  email: { linked: boolean; address: string | null; verifiedAt: string | null };
  phone: { linked: boolean; number: string | null; verifiedAt: string | null };
  passwordSet: boolean;
}

export interface TelegramLoginPayload {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

export interface AuthUser {
  organizerVerified?: boolean;
  restricted?: boolean;
  id: string;
  telegramId: string | null;
  telegramChatId: string | null;
  role: UserRole;
  name: string | null;
  photoUrl: string | null;
  phone: string | null;
  email: string | null;
  defaultCity: string | null;
  defaultCountry?: string | null;
  preferredCurrency?: "KZT" | "RUB" | "USD" | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresInSeconds: number;
  refreshExpiresInSeconds: number;
}

export interface AuthResponse {
  user: AuthUser;
  tokens: AuthTokens;
}

export interface TelegramOidcStartRequest {
  browserProofHash: string;
  returnTo: string;
  locale: "ru" | "kk" | "en";
}

export interface TelegramOidcStartResponse {
  authorizationUrl: string;
  state: string;
  expiresAt: string;
}

export interface TelegramOidcCompleteRequest {
  state: string;
  code: string;
  browserProof: string;
}

export interface TelegramOidcCompleteResponse {
  session: AuthResponse;
  returnTo: string;
}

export interface RefreshResponse {
  tokens: AuthTokens;
}

export interface TelegramLinkTokenResponse {
  token: string;
  deepLinkUrl: string;
  expiresAt: string;
}

/** Account-link deep-link payloads carry this prefix; the bot sends nothing else to consume. */
export const TELEGRAM_LINK_TOKEN_PREFIX = "l_";
export const TELEGRAM_LINK_TOKEN_PATTERN = /^l_[A-Za-z0-9_-]{32}$/;

export interface TelegramLinkConsumeRequest {
  token: string;
  telegramId: number;
  chatId: number;
}

/** Consume records who opened the link and binds nothing; the bot then asks that Telegram user. */
export interface TelegramLinkConsumeResponse {
  attemptId: string;
  /** Masked email or name of the TICKET account that issued the link. */
  account: string;
}

export interface TelegramLinkAnswerRequest {
  attemptId: string;
  telegramId: number;
  chatId: number;
  decision: "confirm" | "cancel";
  firstName?: string;
  lastName?: string;
}

/** pending: the web account page must now confirm; linked: done (same Telegram identity); cancelled. */
export interface TelegramLinkAnswerResponse {
  state: "pending" | "linked" | "cancelled";
}

export interface AccountSession {
  id: string;
  startedAt: string;
  lastUsedAt: string;
  expiresAt: string;
  current: boolean;
}

export interface AccountSessionList {
  items: AccountSession[];
}
