import { databaseSuiteEnabled } from "@event-platform/database/test-database-guard";

export const draftDatabaseTests = databaseSuiteEnabled("event creation drafts", "EVENT_CREATION_DB_TEST");
