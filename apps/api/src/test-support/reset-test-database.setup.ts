// Vitest setup file: before each spec file, empty every table of a *disposable*
// test database (a freshly migrated DB holds only `_prisma_migrations`), so suites
// that count global rows (catalog, expiry) do not see another suite's residue.
// Does nothing unless the DB passes the shared guard, so it can never touch the dev DB.
import { createPrismaClient } from "@event-platform/database";
import { disposableDatabaseProblem } from "@event-platform/database/test-database-guard";

if (disposableDatabaseProblem(process.env.DATABASE_URL) === null) {
  const db = createPrismaClient();
  try {
    const tables = await db.$queryRaw<Array<{ name: string }>>`
      SELECT quote_ident(tablename) AS name FROM pg_tables
      WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations'`;
    if (tables.length) await db.$executeRawUnsafe(`TRUNCATE ${tables.map(({ name }) => name).join(", ")} RESTART IDENTITY CASCADE`);
  } finally {
    await db.$disconnect();
  }
}
