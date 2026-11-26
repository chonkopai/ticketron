/**
 * The development payment provider returns the status page itself as the payment link.
 * Showing it as "continue payment" on that page would only reload the page, so callers hide it.
 */
export function externalPaymentLink(link: string | null | undefined, current: string): string | null {
  if (!link) return null;
  try {
    const target = new URL(link, current), here = new URL(current);
    return target.origin === here.origin && target.pathname === here.pathname ? null : target.toString();
  } catch {
    return null;
  }
}
