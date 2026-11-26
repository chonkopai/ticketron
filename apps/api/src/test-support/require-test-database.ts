// Side-effect import for DB-backed suites. Import it FIRST so the refusal fires
// before any module touches Prisma. See packages/database/src/test-database-guard.ts.
import { assertDisposableDatabase } from "@event-platform/database/test-database-guard";

assertDisposableDatabase("apps/api integration suite");
