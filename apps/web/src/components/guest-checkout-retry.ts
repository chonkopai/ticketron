/** A 4xx (except 408/429) means the server definitively rejected the request: no order exists, so the key can be discarded. */
export function isDefiniteCheckoutFailure(status: number | undefined): boolean {
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429;
}
