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
