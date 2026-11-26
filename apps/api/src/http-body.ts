import type { IncomingMessage, ServerResponse } from "node:http";
import { json, urlencoded } from "body-parser";
import type { NestExpressApplication } from "@nestjs/platform-express";

type Request = IncomingMessage & { path?: string; rawBody?: Buffer };
type Middleware = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void;

/** Nest's own parsers are off: `configureBodyParsers` decides per route. */
export const BODY_PARSER_APP_OPTIONS = { bodyParser: false } as const;

/** Hall-editor documents (a 2,000-seat hall exceeds the 100 KB default). */
const LARGE_JSON_ROUTES = /^\/(?:creation-drafts\/[^/]+|organizer\/(?:events\/[^/]+\/venue-layout(?:\/apply-template)?|venue-layout-templates|venue-layouts\/[^/]+(?:\/templates)?))\/?$/;
/** Signed provider webhooks need the exact bytes; no other route keeps a raw copy. */
const WEBHOOK_ROUTES = /^\/payments\/webhooks\/[^/]+\/?$/;

const keepRaw = (req: Request, _res: ServerResponse, buffer: Buffer) => { req.rawBody = buffer; };
const only = (route: RegExp, parser: Middleware): Middleware => (req, res, next) => route.test((req as Request).path ?? "") ? parser(req, res, next) : next();

/** Scoped JSON limits: 4 MB and raw bodies only where needed, Express defaults elsewhere.
 * A parser skips a request an earlier one already parsed, so the scoped ones go first. */
export function configureBodyParsers(app: Pick<NestExpressApplication, "use">): void {
  app.use(only(LARGE_JSON_ROUTES, json({ limit: "4mb" })));
  app.use(only(WEBHOOK_ROUTES, json({ limit: "1mb", verify: keepRaw })));
  app.use(only(WEBHOOK_ROUTES, urlencoded({ extended: true, limit: "1mb", verify: keepRaw })));
  app.use(json());
  app.use(urlencoded({ extended: true }));
}
