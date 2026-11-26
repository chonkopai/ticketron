const DEFAULT_EXPONENT = 2;

/** Number of minor-unit digits for an ISO 4217 currency (2 for KZT, USD, RUB, EUR; 0 for JPY). */
export function currencyExponent(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? DEFAULT_EXPONENT;
  } catch {
    return DEFAULT_EXPONENT;
  }
}

/** Converts an integer amount in minor units to major units, for example 150050 KZT tiyn to 1500.5. */
export function minorToMajor(minorUnits: number, currency: string): number {
  return minorUnits / 10 ** currencyExponent(currency);
}

/**
 * Formats an amount stored in minor units as a localized currency string.
 * `options` are passed to Intl.NumberFormat on top of `style: "currency"`.
 */
export function formatMoney(minorUnits: number, currency: string, locale: string, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency, ...options }).format(minorToMajor(minorUnits, currency));
}
