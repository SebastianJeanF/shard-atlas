import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

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

export const backupCheckpoints = sqliteTable('backup_checkpoints', {
  id: text('id').primaryKey().notNull(),
  libraryId: text('library_id').notNull(),
  requestId: text('request_id').notNull(),
  sourceKey: text('source_key').notNull(),
  kind: text('kind').notNull(),
  deviceId: text('device_id').notNull().default(''),
  sourceRevision: text('source_revision').notNull().default(''),
  manifest: text('manifest').notNull(),
  fingerprint: text('fingerprint').notNull(),
  reason: text('reason').notNull().default(''),
  status: text('status').notNull().default('staged'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  metadata: text('metadata').notNull().default('{}'),
  leaseId: text('lease_id').notNull().default(''),
  leaseUntil: text('lease_until').notNull().default(''),
  driveFileId: text('drive_file_id').notNull().default(''),
  compressedSha256: text('compressed_sha256').notNull().default(''),
  compressedBytes: integer('compressed_bytes').notNull().default(0),
  verifiedAt: text('verified_at').notNull().default(''),
  lastError: text('last_error').notNull().default(''),
  archivedFolderId: text('archived_folder_id').notNull().default(''),
}, table => [
  uniqueIndex('backup_checkpoints_request').on(table.libraryId, table.requestId),
  uniqueIndex('backup_checkpoints_source').on(table.libraryId, table.sourceKey),
  index('backup_checkpoints_history').on(table.libraryId, table.createdAt, table.id),
]);

export const backupRestores = sqliteTable('backup_restores', {
  id: text('id').primaryKey().notNull(),
  libraryId: text('library_id').notNull(),
  checkpointId: text('checkpoint_id').notNull(),
  expectedRevision: text('expected_revision').notNull(),
  manifest: text('manifest').notNull().default(''),
  fingerprint: text('fingerprint').notNull().default(''),
  counts: text('counts').notNull().default('{}'),
  status: text('status').notNull().default('queued'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  acceptedRevision: text('accepted_revision').notNull().default(''),
  preRestoreCheckpointId: text('pre_restore_checkpoint_id').notNull().default(''),
}, table => [index('backup_restores_history').on(table.libraryId, table.createdAt, table.id)]);

export const imageUploads = sqliteTable('image_uploads', {
  id: text('id').primaryKey().notNull(),
  ownerId: text('owner_id').notNull(),
  requestId: text('request_id').notNull(),
  fileIdHash: text('file_id_hash').notNull(),
  sha256: text('sha256').notNull(),
  name: text('name').notNull(),
  mimeType: text('mime_type').notNull(),
  bytes: integer('bytes').notNull(),
  status: text('status').notNull(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
}, table => [
  uniqueIndex('image_uploads_request').on(table.ownerId, table.requestId),
  index('image_uploads_expiry').on(table.ownerId, table.expiresAt),
]);
