CREATE TABLE `backup_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`library_id` text NOT NULL,
	`request_id` text NOT NULL,
	`source_key` text NOT NULL,
	`kind` text NOT NULL,
	`device_id` text DEFAULT '' NOT NULL,
	`source_revision` text DEFAULT '' NOT NULL,
	`manifest` text NOT NULL,
	`fingerprint` text NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'staged' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`lease_id` text DEFAULT '' NOT NULL,
	`lease_until` text DEFAULT '' NOT NULL,
	`drive_file_id` text DEFAULT '' NOT NULL,
	`compressed_sha256` text DEFAULT '' NOT NULL,
	`compressed_bytes` integer DEFAULT 0 NOT NULL,
	`verified_at` text DEFAULT '' NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	`archived_folder_id` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backup_checkpoints_request` ON `backup_checkpoints` (`library_id`,`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `backup_checkpoints_source` ON `backup_checkpoints` (`library_id`,`source_key`);--> statement-breakpoint
CREATE INDEX `backup_checkpoints_history` ON `backup_checkpoints` (`library_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `backup_restores` (
	`id` text PRIMARY KEY NOT NULL,
	`library_id` text NOT NULL,
	`checkpoint_id` text NOT NULL,
	`expected_revision` text NOT NULL,
	`manifest` text DEFAULT '' NOT NULL,
	`fingerprint` text DEFAULT '' NOT NULL,
	`counts` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`accepted_revision` text DEFAULT '' NOT NULL,
	`pre_restore_checkpoint_id` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `backup_restores_history` ON `backup_restores` (`library_id`,`created_at`,`id`);