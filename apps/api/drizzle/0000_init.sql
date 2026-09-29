CREATE TYPE "public"."salary_adjustment_type" AS ENUM('BONUS', 'OVERTIME', 'DEDUCTION', 'ADVANCE', 'ADJUSTMENT');--> statement-breakpoint
CREATE TYPE "public"."attendance_status" AS ENUM('PRESENT', 'ABSENT', 'HALF_DAY', 'LEAVE', 'HOLIDAY');--> statement-breakpoint
CREATE TYPE "public"."auth_token_purpose" AS ENUM('EMAIL_VERIFY', 'PASSWORD_RESET');--> statement-breakpoint
CREATE TYPE "public"."bill_frequency" AS ENUM('ONE_TIME', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY', 'CUSTOM');--> statement-breakpoint
CREATE TYPE "public"."bill_status" AS ENUM('ACTIVE', 'PAUSED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."completion_status" AS ENUM('PENDING', 'COMPLETED', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('PENDING', 'SENT', 'FAILED', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."househelp_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TYPE "public"."household_role" AS ENUM('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');--> statement-breakpoint
CREATE TYPE "public"."identity_provider" AS ENUM('GOOGLE', 'APPLE', 'PHONE_OTP');--> statement-breakpoint
CREATE TYPE "public"."member_status" AS ENUM('ACTIVE', 'INVITED', 'REMOVED');--> statement-breakpoint
CREATE TYPE "public"."notification_category" AS ENUM('BILL', 'SALARY', 'ATTENDANCE', 'CHECKLIST', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('IN_APP', 'WEB_PUSH', 'EMAIL', 'SMS', 'WHATSAPP');--> statement-breakpoint
CREATE TYPE "public"."notification_severity" AS ENUM('INFO', 'SUCCESS', 'WARNING', 'URGENT');--> statement-breakpoint
CREATE TYPE "public"."bill_occurrence_status" AS ENUM('PENDING', 'PARTIALLY_PAID', 'PAID', 'WAIVED');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('CASH', 'UPI', 'BANK_TRANSFER', 'CARD', 'AUTO_DEBIT', 'CHEQUE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."reminder_target" AS ENUM('BILL', 'SALARY', 'CHECKLIST', 'ATTENDANCE');--> statement-breakpoint
CREATE TYPE "public"."salary_mode" AS ENUM('FIXED_MONTHLY', 'ATTENDANCE_BASED', 'DAILY_RATE');--> statement-breakpoint
CREATE TYPE "public"."settlement_status" AS ENUM('PENDING', 'PARTIALLY_PAID', 'PAID', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."task_frequency" AS ENUM('DAILY', 'WEEKLY', 'WEEKDAYS', 'MONTHLY', 'SPECIFIC_DATE', 'CUSTOM');--> statement-breakpoint
CREATE TYPE "public"."task_priority" AS ENUM('LOW', 'NORMAL', 'HIGH');--> statement-breakpoint
CREATE TABLE "attendance_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"househelp_id" uuid NOT NULL,
	"date" date NOT NULL,
	"status" "attendance_status" NOT NULL,
	"note" text,
	"marked_by_user_id" uuid,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"client_mutation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendance_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"househelp_id" uuid NOT NULL,
	"weekdays" smallint[] NOT NULL,
	"start_time" time,
	"end_time" time,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"old_value" jsonb,
	"new_value" jsonb,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "identity_provider" NOT NULL,
	"provider_subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" "auth_token_purpose" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bill_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bill_categories_hh_id_uq" UNIQUE("household_id","id")
);
--> statement-breakpoint
CREATE TABLE "bill_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"due_date" date NOT NULL,
	"amount_due_paise" bigint NOT NULL,
	"amount_paid_paise" bigint DEFAULT 0 NOT NULL,
	"status" "bill_occurrence_status" DEFAULT 'PENDING' NOT NULL,
	"paid_at" timestamp with time zone,
	"waived_at" timestamp with time zone,
	"waived_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bill_occurrences_hh_id_uq" UNIQUE("household_id","id"),
	CONSTRAINT "bill_occurrences_amounts_ck" CHECK ("bill_occurrences"."amount_due_paise" >= 0 and "bill_occurrences"."amount_paid_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "bill_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"paid_on" date NOT NULL,
	"method" "payment_method" NOT NULL,
	"transaction_ref" text,
	"notes" text,
	"recorded_by_user_id" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bill_payments_positive_ck" CHECK ("bill_payments"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category_id" uuid,
	"provider" text,
	"account_number" text,
	"amount_paise" bigint,
	"frequency" "bill_frequency" NOT NULL,
	"interval_count" smallint DEFAULT 1 NOT NULL,
	"interval_unit" text,
	"first_due_date" date NOT NULL,
	"end_date" date,
	"payment_method" "payment_method",
	"autopay" boolean DEFAULT false NOT NULL,
	"status" "bill_status" DEFAULT 'ACTIVE' NOT NULL,
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bills_hh_id_uq" UNIQUE("household_id","id"),
	CONSTRAINT "bills_amount_nonneg_ck" CHECK (coalesce("bills"."amount_paise",0) >= 0),
	CONSTRAINT "bills_interval_ck" CHECK ("bills"."interval_count" >= 1)
);
--> statement-breakpoint
CREATE TABLE "checklist_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"househelp_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checklist_completions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"househelp_id" uuid,
	"date" date NOT NULL,
	"status" "completion_status" NOT NULL,
	"note" text,
	"recorded_by_user_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"client_mutation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checklist_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category_id" uuid,
	"frequency" "task_frequency" NOT NULL,
	"weekdays" smallint[],
	"day_of_month" smallint,
	"specific_date" date,
	"interval_days" smallint,
	"anchor_date" date,
	"preferred_time" time,
	"priority" "task_priority" DEFAULT 'NORMAL' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checklist_tasks_hh_id_uq" UNIQUE("household_id","id")
);
--> statement-breakpoint
CREATE TABLE "househelp_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "househelp_categories_hh_id_uq" UNIQUE("household_id","id")
);
--> statement-breakpoint
CREATE TABLE "househelp_category_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"househelp_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "househelps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"photo_url" text,
	"role_title" text,
	"status" "househelp_status" DEFAULT 'ACTIVE' NOT NULL,
	"start_date" date,
	"end_date" date,
	"salary_mode" "salary_mode" DEFAULT 'FIXED_MONTHLY' NOT NULL,
	"monthly_salary_paise" bigint,
	"daily_rate_paise" bigint,
	"half_day_rate_paise" bigint,
	"salary_due_day" smallint DEFAULT 1 NOT NULL,
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "househelps_hh_id_uq" UNIQUE("household_id","id"),
	CONSTRAINT "househelps_due_day_ck" CHECK ("househelps"."salary_due_day" between 1 and 31),
	CONSTRAINT "househelps_salary_nonneg_ck" CHECK (coalesce("househelps"."monthly_salary_paise",0) >= 0 and coalesce("househelps"."daily_rate_paise",0) >= 0 and coalesce("househelps"."half_day_rate_paise",0) >= 0)
);
--> statement-breakpoint
CREATE TABLE "household_expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"description" text NOT NULL,
	"category" text,
	"amount_paise" bigint NOT NULL,
	"spent_on" date NOT NULL,
	"method" "payment_method",
	"recorded_by_user_id" uuid,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_expenses_positive_ck" CHECK ("household_expenses"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "household_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "household_role" NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "household_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "household_role" NOT NULL,
	"status" "member_status" DEFAULT 'ACTIVE' NOT NULL,
	"display_name" text,
	"invited_by_user_id" uuid,
	"joined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "households" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"role_permission_overrides" jsonb,
	"onboarding_completed_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"notification_id" uuid NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"status" "delivery_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"category" "notification_category" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"channels" "notification_channel"[] DEFAULT '{IN_APP,WEB_PUSH}'::notification_channel[] NOT NULL,
	"offsets_days" smallint[],
	"send_hour" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"category" "notification_category" NOT NULL,
	"severity" "notification_severity" DEFAULT 'INFO' NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"entity_type" text,
	"entity_id" uuid,
	"data" jsonb,
	"idempotency_key" text NOT NULL,
	"read_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminder_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"target_type" "reminder_target" NOT NULL,
	"target_id" uuid,
	"offsets_days" smallint[] NOT NULL,
	"overdue_daily" boolean DEFAULT true NOT NULL,
	"send_hour" smallint DEFAULT 9 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminder_rules_hour_ck" CHECK ("reminder_rules"."send_hour" between 0 and 23)
);
--> statement-breakpoint
CREATE TABLE "salary_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"househelp_id" uuid NOT NULL,
	"settlement_id" uuid,
	"period_month" date NOT NULL,
	"type" "salary_adjustment_type" NOT NULL,
	"amount_paise" bigint NOT NULL,
	"reason" text,
	"created_by_user_id" uuid,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "salary_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"househelp_id" uuid NOT NULL,
	"settlement_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"paid_on" date NOT NULL,
	"method" "payment_method" NOT NULL,
	"reference" text,
	"notes" text,
	"recorded_by_user_id" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "salary_payments_positive_ck" CHECK ("salary_payments"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "salary_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"househelp_id" uuid NOT NULL,
	"period_month" date NOT NULL,
	"due_date" date NOT NULL,
	"base_paise" bigint NOT NULL,
	"working_days" smallint NOT NULL,
	"present_days" smallint DEFAULT 0 NOT NULL,
	"half_days" smallint DEFAULT 0 NOT NULL,
	"absent_days" smallint DEFAULT 0 NOT NULL,
	"leave_days" smallint DEFAULT 0 NOT NULL,
	"absence_deduction_paise" bigint DEFAULT 0 NOT NULL,
	"additions_paise" bigint DEFAULT 0 NOT NULL,
	"deductions_paise" bigint DEFAULT 0 NOT NULL,
	"advance_paise" bigint DEFAULT 0 NOT NULL,
	"net_payable_paise" bigint NOT NULL,
	"amount_paid_paise" bigint DEFAULT 0 NOT NULL,
	"status" "settlement_status" DEFAULT 'PENDING' NOT NULL,
	"calc_snapshot" jsonb,
	"note" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "salary_settlements_hh_id_uq" UNIQUE("household_id","id"),
	CONSTRAINT "salary_settlements_period_first_ck" CHECK (extract(day from "salary_settlements"."period_month") = 1)
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"user_agent" text,
	"ip_address" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"password_hash" text,
	"phone" text,
	"phone_verified_at" timestamp with time zone,
	"locale" text DEFAULT 'en-IN' NOT NULL,
	"timezone" text,
	"password_changed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_marked_by_user_id_users_id_fk" FOREIGN KEY ("marked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_househelp_fk" FOREIGN KEY ("household_id","househelp_id") REFERENCES "public"."househelps"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_schedules" ADD CONSTRAINT "attendance_schedules_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_schedules" ADD CONSTRAINT "as_househelp_fk" FOREIGN KEY ("household_id","househelp_id") REFERENCES "public"."househelps"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_categories" ADD CONSTRAINT "bill_categories_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_occurrences" ADD CONSTRAINT "bill_occurrences_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_occurrences" ADD CONSTRAINT "bill_occurrences_waived_by_user_id_users_id_fk" FOREIGN KEY ("waived_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_occurrences" ADD CONSTRAINT "bo_bill_fk" FOREIGN KEY ("household_id","bill_id") REFERENCES "public"."bills"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_payments" ADD CONSTRAINT "bill_payments_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_payments" ADD CONSTRAINT "bill_payments_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_payments" ADD CONSTRAINT "bp_bill_fk" FOREIGN KEY ("household_id","bill_id") REFERENCES "public"."bills"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_payments" ADD CONSTRAINT "bp_occurrence_fk" FOREIGN KEY ("household_id","occurrence_id") REFERENCES "public"."bill_occurrences"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_category_fk" FOREIGN KEY ("household_id","category_id") REFERENCES "public"."bill_categories"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_assignments" ADD CONSTRAINT "checklist_assignments_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_assignments" ADD CONSTRAINT "ca_task_fk" FOREIGN KEY ("household_id","task_id") REFERENCES "public"."checklist_tasks"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_assignments" ADD CONSTRAINT "ca_househelp_fk" FOREIGN KEY ("household_id","househelp_id") REFERENCES "public"."househelps"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_completions" ADD CONSTRAINT "checklist_completions_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_completions" ADD CONSTRAINT "checklist_completions_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_completions" ADD CONSTRAINT "cc_task_fk" FOREIGN KEY ("household_id","task_id") REFERENCES "public"."checklist_tasks"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_completions" ADD CONSTRAINT "cc_househelp_fk" FOREIGN KEY ("household_id","househelp_id") REFERENCES "public"."househelps"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_tasks" ADD CONSTRAINT "checklist_tasks_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_tasks" ADD CONSTRAINT "ct_category_fk" FOREIGN KEY ("household_id","category_id") REFERENCES "public"."househelp_categories"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "househelp_categories" ADD CONSTRAINT "househelp_categories_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "househelp_category_links" ADD CONSTRAINT "househelp_category_links_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "househelp_category_links" ADD CONSTRAINT "hcl_househelp_fk" FOREIGN KEY ("household_id","househelp_id") REFERENCES "public"."househelps"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "househelp_category_links" ADD CONSTRAINT "hcl_category_fk" FOREIGN KEY ("household_id","category_id") REFERENCES "public"."househelp_categories"("household_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "househelps" ADD CONSTRAINT "househelps_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_expenses" ADD CONSTRAINT "household_expenses_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_expenses" ADD CONSTRAINT "household_expenses_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_invites" ADD CONSTRAINT "household_invites_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_invites" ADD CONSTRAINT "household_invites_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "households" ADD CONSTRAINT "households_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_rules" ADD CONSTRAINT "reminder_rules_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_adjustments" ADD CONSTRAINT "salary_adjustments_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_adjustments" ADD CONSTRAINT "salary_adjustments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_adjustments" ADD CONSTRAINT "sa_househelp_fk" FOREIGN KEY ("household_id","househelp_id") REFERENCES "public"."househelps"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_adjustments" ADD CONSTRAINT "sa_settlement_fk" FOREIGN KEY ("household_id","settlement_id") REFERENCES "public"."salary_settlements"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_payments" ADD CONSTRAINT "salary_payments_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_payments" ADD CONSTRAINT "salary_payments_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_payments" ADD CONSTRAINT "sp_househelp_fk" FOREIGN KEY ("household_id","househelp_id") REFERENCES "public"."househelps"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_payments" ADD CONSTRAINT "sp_settlement_fk" FOREIGN KEY ("household_id","settlement_id") REFERENCES "public"."salary_settlements"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_settlements" ADD CONSTRAINT "salary_settlements_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_settlements" ADD CONSTRAINT "ss_househelp_fk" FOREIGN KEY ("household_id","househelp_id") REFERENCES "public"."househelps"("household_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_helper_date_uq" ON "attendance_records" USING btree ("househelp_id","date");--> statement-breakpoint
CREATE INDEX "attendance_hh_date_idx" ON "attendance_records" USING btree ("household_id","date");--> statement-breakpoint
CREATE INDEX "attendance_hh_helper_idx" ON "attendance_records" USING btree ("household_id","househelp_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_client_mutation_uq" ON "attendance_records" USING btree ("household_id","client_mutation_id") WHERE "attendance_records"."client_mutation_id" is not null;--> statement-breakpoint
CREATE INDEX "attendance_schedules_hh_helper_idx" ON "attendance_schedules" USING btree ("household_id","househelp_id","effective_from");--> statement-breakpoint
CREATE INDEX "audit_logs_hh_created_idx" ON "audit_logs" USING btree ("household_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_identities_provider_subject_uq" ON "auth_identities" USING btree ("provider","provider_subject");--> statement-breakpoint
CREATE INDEX "auth_identities_user_idx" ON "auth_identities" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_tokens_hash_uq" ON "auth_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_tokens_user_purpose_idx" ON "auth_tokens" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE UNIQUE INDEX "bill_categories_hh_name_uq" ON "bill_categories" USING btree ("household_id",lower("name")) WHERE "bill_categories"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "bill_occurrences_bill_seq_uq" ON "bill_occurrences" USING btree ("bill_id","sequence");--> statement-breakpoint
CREATE INDEX "bill_occurrences_hh_due_idx" ON "bill_occurrences" USING btree ("household_id","due_date");--> statement-breakpoint
CREATE INDEX "bill_occurrences_hh_status_due_idx" ON "bill_occurrences" USING btree ("household_id","status","due_date");--> statement-breakpoint
CREATE INDEX "bill_payments_hh_paid_idx" ON "bill_payments" USING btree ("household_id","paid_on");--> statement-breakpoint
CREATE INDEX "bill_payments_occurrence_idx" ON "bill_payments" USING btree ("occurrence_id");--> statement-breakpoint
CREATE INDEX "bills_hh_status_idx" ON "bills" USING btree ("household_id","status");--> statement-breakpoint
CREATE INDEX "checklist_assignments_hh_helper_idx" ON "checklist_assignments" USING btree ("household_id","househelp_id");--> statement-breakpoint
CREATE INDEX "checklist_assignments_task_idx" ON "checklist_assignments" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_completions_task_date_uq" ON "checklist_completions" USING btree ("task_id","date");--> statement-breakpoint
CREATE INDEX "checklist_completions_hh_date_idx" ON "checklist_completions" USING btree ("household_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_completions_client_mutation_uq" ON "checklist_completions" USING btree ("household_id","client_mutation_id") WHERE "checklist_completions"."client_mutation_id" is not null;--> statement-breakpoint
CREATE INDEX "checklist_tasks_hh_active_idx" ON "checklist_tasks" USING btree ("household_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "househelp_categories_hh_name_uq" ON "househelp_categories" USING btree ("household_id",lower("name")) WHERE "househelp_categories"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "househelp_categories_hh_order_idx" ON "househelp_categories" USING btree ("household_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "househelp_category_links_uq" ON "househelp_category_links" USING btree ("househelp_id","category_id");--> statement-breakpoint
CREATE INDEX "househelps_hh_status_idx" ON "househelps" USING btree ("household_id","status");--> statement-breakpoint
CREATE INDEX "household_expenses_hh_date_idx" ON "household_expenses" USING btree ("household_id","spent_on");--> statement-breakpoint
CREATE UNIQUE INDEX "household_invites_token_uq" ON "household_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "household_invites_household_idx" ON "household_invites" USING btree ("household_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "household_members_household_user_uq" ON "household_members" USING btree ("household_id","user_id");--> statement-breakpoint
CREATE INDEX "household_members_user_idx" ON "household_members" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_uq" ON "notification_deliveries" USING btree ("notification_id","channel");--> statement-breakpoint
CREATE INDEX "notification_deliveries_status_idx" ON "notification_deliveries" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_prefs_uq" ON "notification_preferences" USING btree ("household_id","user_id","category");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_idempotency_uq" ON "notifications" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "notifications_user_hh_created_idx" ON "notifications" USING btree ("user_id","household_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_user_unread_idx" ON "notifications" USING btree ("user_id","household_id") WHERE "notifications"."read_at" is null and "notifications"."dismissed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_uq" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_idx" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reminder_rules_target_uq" ON "reminder_rules" USING btree ("household_id","target_type",coalesce("target_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE INDEX "salary_adjustments_hh_helper_period_idx" ON "salary_adjustments" USING btree ("household_id","househelp_id","period_month");--> statement-breakpoint
CREATE INDEX "salary_payments_hh_helper_idx" ON "salary_payments" USING btree ("household_id","househelp_id","paid_on");--> statement-breakpoint
CREATE UNIQUE INDEX "salary_settlements_helper_period_uq" ON "salary_settlements" USING btree ("househelp_id","period_month");--> statement-breakpoint
CREATE INDEX "salary_settlements_hh_status_due_idx" ON "salary_settlements" USING btree ("household_id","status","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "user_sessions_token_uq" ON "user_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "user_sessions_user_idx" ON "user_sessions" USING btree ("user_id","revoked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_phone_uq" ON "users" USING btree ("phone") WHERE "users"."phone" is not null;