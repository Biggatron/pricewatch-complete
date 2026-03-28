CREATE TABLE "user_account" (
  "id" serial PRIMARY KEY,
  "google_id" varchar(32),
  "email" varchar(256),
  "name" varchar(128),
  "hashed_password" bytea,
  "salt" bytea,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "last_modified_at" timestamp NOT NULL DEFAULT now(),
  "last_modified_by" integer,
  "deleted" boolean DEFAULT FALSE
);

CREATE TABLE track (
    "id" serial primary key,
    "orig_price" decimal,
    "curr_price" decimal,
    "requires_javascript" boolean,
    "price_url" varchar(2048),
    "price_div" varchar(2048),
    "product_name" varchar(64),
    "user_id" integer,
    "email" varchar(256),
    "active" boolean,
    "created_at" timestamp,
    "last_modified_at" timestamp
);

CREATE TABLE email_logs (
    "id" serial primary key,
    "track_id" integer,
    "product_name" varchar(64),
    "orig_price" decimal,
    "curr_price" decimal,
    "email" varchar(256),
    "email_type" varchar(64),
    "status" varchar(32),
    "subject" text,
    "body" text,
    "error_message" text,
    "delivered" boolean,
    "sent_at" timestamp,
    "created_at" timestamp
);

CREATE TABLE failed_track_logs (
    "id" serial primary key,
    "product_price" varchar(64),
    "product_url" varchar(2048),
    "domain" varchar(128),
    "created_at" timestamp
);

CREATE TABLE app_config (
    "id" serial primary key,
    "config_key" varchar(128) NOT NULL UNIQUE,
    "category" varchar(64),
    "value" text,
    "data_type" varchar(32) NOT NULL DEFAULT 'string',
    "description" text,
    "value_help" text,
    "created_at" timestamp NOT NULL DEFAULT now(),
    "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE crawler_failure_logs (
    "id" serial primary key,
    "run_id" integer,
    "run_item_id" integer,
    "track_id" integer,
    "user_id" integer,
    "user_email" varchar(256),
    "action" varchar(64),
    "stage" varchar(64),
    "product_name" varchar(256),
    "product_url" varchar(2048),
    "requires_javascript" boolean,
    "html_file_path" varchar(1024),
    "error_message" text,
    "error_stack" text,
    "details" text,
    "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE crawler_runs (
    "id" serial primary key,
    "trigger_type" varchar(64),
    "triggered_by_user_id" integer,
    "triggered_by_email" varchar(256),
    "status" varchar(32),
    "started_at" timestamp NOT NULL DEFAULT now(),
    "finished_at" timestamp,
    "duration_ms" integer,
    "track_count" integer DEFAULT 0,
    "html_success_count" integer DEFAULT 0,
    "html_failure_count" integer DEFAULT 0,
    "unchanged_count" integer DEFAULT 0,
    "updated_count" integer DEFAULT 0,
    "lowered_count" integer DEFAULT 0,
    "increased_count" integer DEFAULT 0,
    "inactive_count" integer DEFAULT 0,
    "reactivated_count" integer DEFAULT 0,
    "error_count" integer DEFAULT 0,
    "biggest_drop_amount" decimal,
    "biggest_increase_amount" decimal
);

CREATE TABLE crawler_run_items (
    "id" serial primary key,
    "run_id" integer,
    "track_id" integer,
    "user_id" integer,
    "product_name" varchar(256),
    "product_url" varchar(2048),
    "requires_javascript" boolean,
    "status" varchar(64),
    "stage" varchar(64),
    "html_lookup_success" boolean,
    "previous_price" decimal,
    "current_price" decimal,
    "price_direction" varchar(32),
    "marked_inactive" boolean DEFAULT FALSE,
    "reactivated" boolean DEFAULT FALSE,
    "failure_log_id" integer,
    "error_message" text,
    "duration_ms" integer,
    "created_at" timestamp NOT NULL DEFAULT now()
);

-- Add foreign keys
ALTER TABLE "track" ADD FOREIGN KEY ("user_id") REFERENCES "user_account" ("id");
ALTER TABLE "email_logs" ADD FOREIGN KEY ("track_id") REFERENCES "track" ("id");
ALTER TABLE "crawler_failure_logs" ADD FOREIGN KEY ("track_id") REFERENCES "track" ("id");
ALTER TABLE "crawler_failure_logs" ADD FOREIGN KEY ("user_id") REFERENCES "user_account" ("id");
ALTER TABLE "crawler_failure_logs" ADD FOREIGN KEY ("run_id") REFERENCES "crawler_runs" ("id");
ALTER TABLE "crawler_failure_logs" ADD FOREIGN KEY ("run_item_id") REFERENCES "crawler_run_items" ("id");
ALTER TABLE "crawler_run_items" ADD FOREIGN KEY ("run_id") REFERENCES "crawler_runs" ("id");
ALTER TABLE "crawler_run_items" ADD FOREIGN KEY ("track_id") REFERENCES "track" ("id");
ALTER TABLE "crawler_run_items" ADD FOREIGN KEY ("user_id") REFERENCES "user_account" ("id");
ALTER TABLE "crawler_run_items" ADD FOREIGN KEY ("failure_log_id") REFERENCES "crawler_failure_logs" ("id");
