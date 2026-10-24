CREATE TABLE `library_commits` (
	`id` text PRIMARY KEY NOT NULL,
	`library_id` text NOT NULL,
	`mutation_id` text NOT NULL,
	`base_revision` text NOT NULL,
	`fingerprint` text NOT NULL,
	`manifest` text NOT NULL,
	`status` text NOT NULL,
	`observed_revision` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_commits_mutation` ON `library_commits` (`library_id`,`mutation_id`);--> statement-breakpoint
CREATE INDEX `library_commits_history` ON `library_commits` (`library_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `library_heads` (
	`library_id` text PRIMARY KEY NOT NULL,
	`revision` text DEFAULT '' NOT NULL
);
