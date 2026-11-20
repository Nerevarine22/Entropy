CREATE TABLE `entropy_daily_ranks` (
	`day` text NOT NULL,
	`board` text NOT NULL,
	`ranks` text NOT NULL,
	PRIMARY KEY(`day`, `board`)
);
