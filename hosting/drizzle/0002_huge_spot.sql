CREATE TABLE `image_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`request_id` text NOT NULL,
	`file_id_hash` text NOT NULL,
	`sha256` text NOT NULL,
	`name` text NOT NULL,
	`mime_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `image_uploads_request` ON `image_uploads` (`owner_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `image_uploads_expiry` ON `image_uploads` (`owner_id`,`expires_at`);