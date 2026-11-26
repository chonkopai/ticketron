/** Express request fields used to identify the calling client. */
export type ClientAddressRequest = { ip?: string; socket?: { remoteAddress?: string } };

/**
 * The client address for rate limits and quotas.
 *
 * `req.ip` is resolved by Express through the configured `trust proxy` hops
 * (`configureHttpProxy`), so behind Caddy → Next it is the real client, and a
 * forged leading `X-Forwarded-For` entry is ignored. Never read
 * `socket.remoteAddress` first: behind the proxy chain it is always the web
 * container, which would put every visitor into one bucket.
 */
export function clientAddress(request: ClientAddressRequest): string {
  return request.ip ?? request.socket?.remoteAddress ?? "unknown";
}
