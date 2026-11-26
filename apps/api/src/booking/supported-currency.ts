import { loadApiEnv } from "@event-platform/config";
import { BadRequestException } from "@nestjs/common";

import type { CurrencyCapability } from "@event-platform/shared-types";

import { configuredPaymentCurrencies } from "./payment-provider.js";

/**
 * Normalizes a currency code from an editor request and accepts it only when the configured
 * payment provider supports it (the same list event creation and the hall library use).
 */
export function supportedCurrency(value: string | undefined, currencies: readonly CurrencyCapability[] = configuredPaymentCurrencies(loadApiEnv())): string {
  const currency = (value ?? "KZT").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new BadRequestException({ code: "CURRENCY_INVALID", message: "Currency must be a 3-letter code" });
  if (!currencies.some(capability => capability.code === currency)) throw new BadRequestException({ code: "CURRENCY_UNSUPPORTED", message: "Currency is not supported by the payment provider" });
  return currency;
}
