CREATE TABLE "user_account" (
  "id" serial PRIMARY KEY,
  "google_id" varchar(32),
  "email" varchar(128),
  "name" varchar(64),
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
    "email" varchar(128),
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
    "email" varchar(128),
    "delivered" boolean,
    "created_at" timestamp
);

CREATE TABLE failed_track_logs (
    "id" serial primary key,
    "product_price" varchar(64),
    "product_url" varchar(2048),
    "domain" varchar(64),
    "created_at" timestamp
);

-- Add foreign keys
ALTER TABLE "track" ADD FOREIGN KEY ("user_id") REFERENCES "user_account" ("id");
ALTER TABLE "email_logs" ADD FOREIGN KEY ("track_id") REFERENCES "track" ("id");
