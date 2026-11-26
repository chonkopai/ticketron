import { PrismaPg } from "@prisma/adapter-pg";

import { Prisma, PrismaClient } from "./generated/prisma/client.js";

function databaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required to initialize Prisma");
  return value;
}

/** `options` lets tests attach query logging; production callers pass nothing. */
export function createPrismaClient(options: { log?: Array<Prisma.LogLevel | Prisma.LogDefinition> } = {}): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: databaseUrl(),
    connectionTimeoutMillis: 5_000,
  });
  return new PrismaClient({ ...options, adapter });
}

const globalForPrisma = globalThis as typeof globalThis & {
  eventPlatformPrisma?: PrismaClient;
};

export const prisma = globalForPrisma.eventPlatformPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.eventPlatformPrisma = prisma;

export * from "./generated/prisma/client.js";
export * from "./event-v2-compat.js";
