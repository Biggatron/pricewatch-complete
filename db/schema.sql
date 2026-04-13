CREATE TABLE "user_account" (
  "id" serial PRIMARY KEY,
  "google_id" varchar(32),
  "email" varchar(256),
  "name" varchar(128),
  "hashed_password" bytea,
  "salt" bytea,
  "is_email_verified" boolean NOT NULL DEFAULT FALSE,
  "email_verification_token_hash" varchar(128),
  "email_verification_token_expires_at" timestamp,
  "email_verification_last_sent_at" timestamp,
  "email_verification_sent_window_started_at" timestamp,
  "email_verification_sent_count" integer NOT NULL DEFAULT 0,
  "password_reset_token_hash" varchar(128),
  "password_reset_token_expires_at" timestamp,
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
    "deleted" boolean NOT NULL DEFAULT FALSE,
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
    "template_key" varchar(64),
    "status" varchar(32),
    "subject" text,
    "body" text,
    "html_body" text,
    "error_message" text,
    "delivered" boolean,
    "sent_at" timestamp,
    "attempt_count" integer NOT NULL DEFAULT 0,
    "last_attempt_at" timestamp,
    "next_send_at" timestamp,
    "created_at" timestamp
);

CREATE TABLE failed_track_logs (
    "id" serial primary key,
    "product_price" varchar(64),
    "product_url" varchar(2048),
    "domain" varchar(128),
    "created_at" timestamp
);

CREATE TABLE domain_access_profiles (
    "id" serial primary key,
    "domain" varchar(255) NOT NULL UNIQUE,
    "preview_mode" varchar(32),
    "crawler_mode" varchar(32),
    "price_lookup_mode" varchar(32),
    "created_at" timestamp NOT NULL DEFAULT now(),
    "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE domain_price_selectors (
    "id" serial primary key,
    "domain" varchar(255) NOT NULL,
    "template_key" varchar(128) NOT NULL,
    "selector_type" varchar(32) NOT NULL,
    "selector_value" text,
    "requires_javascript" boolean NOT NULL DEFAULT FALSE,
    "source_track_id" integer,
    "success_count" integer NOT NULL DEFAULT 0,
    "failure_count" integer NOT NULL DEFAULT 0,
    "last_verified_at" timestamp,
    "last_failed_at" timestamp,
    "is_active" boolean NOT NULL DEFAULT TRUE,
    "created_at" timestamp NOT NULL DEFAULT now(),
    "updated_at" timestamp NOT NULL DEFAULT now()
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

CREATE TABLE preview_screenshot_cache (
    "id" serial primary key,
    "url" varchar(2048) NOT NULL UNIQUE,
    "file_name" varchar(255) NOT NULL UNIQUE,
    "file_path" varchar(1024) NOT NULL,
    "public_path" varchar(1024) NOT NULL,
    "created_at" timestamp NOT NULL DEFAULT now(),
    "last_accessed_at" timestamp NOT NULL DEFAULT now(),
    "expires_at" timestamp NOT NULL
);

CREATE TABLE scheduled_job_runs (
    "id" serial primary key,
    "job_key" varchar(64) NOT NULL,
    "job_name" varchar(128) NOT NULL,
    "cron_expression" text,
    "status" varchar(32) NOT NULL DEFAULT 'pending',
    "run_after_time" timestamp NOT NULL,
    "actual_run_time" timestamp,
    "error_reason" text,
    "created_at" timestamp NOT NULL DEFAULT now(),
    "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE track_change_history (
    "id" serial primary key,
    "track_id" integer NOT NULL,
    "price_before" decimal,
    "price_after" decimal,
    "active" boolean,
    "changed_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX preview_screenshot_cache_expires_at_idx
    ON preview_screenshot_cache ("expires_at");

CREATE INDEX domain_access_profiles_updated_at_idx
    ON domain_access_profiles ("updated_at");

CREATE UNIQUE INDEX domain_price_selectors_domain_template_type_js_unique_idx
    ON domain_price_selectors ("domain", "template_key", "selector_type", "requires_javascript");

CREATE INDEX domain_price_selectors_domain_active_idx
    ON domain_price_selectors ("domain", "is_active", "updated_at" DESC);

CREATE INDEX user_account_email_verification_token_hash_idx
    ON user_account ("email_verification_token_hash");

CREATE INDEX user_account_password_reset_token_hash_idx
    ON user_account ("password_reset_token_hash");

CREATE INDEX scheduled_job_runs_job_key_idx
    ON scheduled_job_runs ("job_key", "run_after_time" DESC, "id" DESC);

CREATE UNIQUE INDEX scheduled_job_runs_pending_job_key_idx
    ON scheduled_job_runs ("job_key")
    WHERE "status" = 'pending';

CREATE INDEX track_change_history_track_id_changed_at_idx
    ON track_change_history ("track_id", "changed_at" DESC, "id" DESC);

CREATE UNIQUE INDEX track_user_id_price_url_active_unique_idx
    ON track ("user_id", "price_url")
    WHERE "deleted" = FALSE
      AND "user_id" IS NOT NULL;

-- Add foreign keys
ALTER TABLE "track" ADD FOREIGN KEY ("user_id") REFERENCES "user_account" ("id");
ALTER TABLE "email_logs" ADD FOREIGN KEY ("track_id") REFERENCES "track" ("id");
ALTER TABLE "track_change_history" ADD FOREIGN KEY ("track_id") REFERENCES "track" ("id");
ALTER TABLE "crawler_failure_logs" ADD FOREIGN KEY ("track_id") REFERENCES "track" ("id");
ALTER TABLE "crawler_failure_logs" ADD FOREIGN KEY ("user_id") REFERENCES "user_account" ("id");
ALTER TABLE "crawler_failure_logs" ADD FOREIGN KEY ("run_id") REFERENCES "crawler_runs" ("id");
ALTER TABLE "crawler_failure_logs" ADD FOREIGN KEY ("run_item_id") REFERENCES "crawler_run_items" ("id");
ALTER TABLE "crawler_run_items" ADD FOREIGN KEY ("run_id") REFERENCES "crawler_runs" ("id");
ALTER TABLE "crawler_run_items" ADD FOREIGN KEY ("track_id") REFERENCES "track" ("id");
ALTER TABLE "crawler_run_items" ADD FOREIGN KEY ("user_id") REFERENCES "user_account" ("id");
ALTER TABLE "crawler_run_items" ADD FOREIGN KEY ("failure_log_id") REFERENCES "crawler_failure_logs" ("id");
