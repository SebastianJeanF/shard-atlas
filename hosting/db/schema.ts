import { sqliteTable, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

export const libraryHeads = sqliteTable('library_heads', {
  libraryId: text('library_id').primaryKey().notNull(),
  revision: text('revision').notNull().default(''),
});

export const libraryCommits = sqliteTable('library_commits', {
  id: text('id').primaryKey().notNull(),
  libraryId: text('library_id').notNull(),
  mutationId: text('mutation_id').notNull(),
  baseRevision: text('base_revision').notNull(),
  fingerprint: text('fingerprint').notNull(),
  manifest: text('manifest').notNull(),
  status: text('status').notNull(),
  observedRevision: text('observed_revision').notNull(),
  createdAt: text('created_at').notNull(),
}, table => [
  uniqueIndex('library_commits_mutation').on(table.libraryId, table.mutationId),
  index('library_commits_history').on(table.libraryId, table.createdAt, table.id),
]);
