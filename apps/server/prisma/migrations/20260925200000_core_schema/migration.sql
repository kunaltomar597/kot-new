-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('OWNER', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN');

-- CreateEnum
CREATE TYPE "CredentialKind" AS ENUM ('PIN', 'PASSWORD', 'TOTP');

-- CreateEnum
CREATE TYPE "DeviceType" AS ENUM ('POS', 'KDS', 'WAITER_PHONE', 'TABLE_TABLET', 'PAGER', 'MANAGER_BROWSER');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "BusinessDayStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "TableState" AS ENUM ('FREE', 'OCCUPIED', 'BILL_REQUESTED', 'BILL_PRINTED');

-- CreateEnum
CREATE TYPE "TableSessionStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "StationMode" AS ENUM ('SCREEN', 'PRINT', 'BOTH');

-- CreateEnum
CREATE TYPE "PrinterConnection" AS ENUM ('NETWORK', 'USB');

-- CreateEnum
CREATE TYPE "FoodType" AS ENUM ('VEG', 'NON_VEG', 'EGG');

-- CreateEnum
CREATE TYPE "SalesChannel" AS ENUM ('POS', 'WAITER_APP', 'TABLE_TABLET', 'QR');

-- CreateEnum
CREATE TYPE "PriceMode" AS ENUM ('TAX_EXCLUSIVE', 'TAX_INCLUSIVE');

-- CreateEnum
CREATE TYPE "ComboComponentKind" AS ENUM ('FIXED', 'CHOICE');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('DINE_IN', 'TAKEAWAY');

-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('POS', 'WAITER_APP', 'TABLE_TABLET', 'QR');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderItemState" AS ENUM ('PENDING_APPROVAL', 'SENT', 'PREPARING', 'READY', 'PICKED_UP', 'SERVED', 'REJECTED', 'CANCELLED', 'VOIDED');

-- CreateEnum
CREATE TYPE "KotKind" AS ENUM ('NEW', 'MODIFIED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "KotPrintStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'PRINTED', 'FAILED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('ISSUED', 'SETTLED', 'VOIDED');

-- CreateEnum
CREATE TYPE "DiscountKind" AS ENUM ('PERCENT', 'FLAT');

-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('CASH', 'CARD', 'UPI', 'OTHER');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CAPTURED', 'REFUNDED', 'VOIDED');

-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "CashDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "CounterKind" AS ENUM ('ORDER', 'KOT', 'TAKEAWAY_TOKEN');

-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN     "address" JSONB,
ADD COLUMN     "business_day_cutoff" TEXT NOT NULL DEFAULT '04:00',
ADD COLUMN     "fssai_number" TEXT,
ADD COLUMN     "gstin" TEXT,
ADD COLUMN     "legal_name" TEXT,
ADD COLUMN     "price_mode" "PriceMode" NOT NULL DEFAULT 'TAX_EXCLUSIVE',
ADD COLUMN     "state_code" TEXT,
ADD COLUMN     "time_zone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "settings" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_days" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "status" "BusinessDayStatus" NOT NULL DEFAULT 'OPEN',
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(3),
    "closed_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_counters" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "kind" "CounterKind" NOT NULL,
    "last_value" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "base_role" "StaffRole" NOT NULL,
    "built_in" BOOLEAN NOT NULL DEFAULT true,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "photo_id" UUID,
    "phone" TEXT,
    "email" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "external_id" TEXT,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credentials" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "kind" "CredentialKind" NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "rotated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "type" "DeviceType" NOT NULL,
    "name" TEXT NOT NULL,
    "status" "DeviceStatus" NOT NULL DEFAULT 'PENDING',
    "public_key" TEXT,
    "certificate_fingerprint" TEXT,
    "paired_at" TIMESTAMPTZ(3),
    "paired_by_id" UUID,
    "revoked_at" TIMESTAMPTZ(3),
    "last_seen_at" TIMESTAMPTZ(3),
    "app_version" TEXT,
    "table_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "last_active_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    "revoke_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sections" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tables" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 4,
    "state" "TableState" NOT NULL DEFAULT 'FREE',
    "layout" JSONB,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "external_id" TEXT,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "table_sessions" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "table_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "status" "TableSessionStatus" NOT NULL DEFAULT 'OPEN',
    "covers" INTEGER,
    "waiter_id" UUID,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(3),
    "close_reason" TEXT,
    "moved_from_session_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "table_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_assignments" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "starts_at" TIMESTAMPTZ(3),
    "ends_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shift_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" TEXT NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "external_id" TEXT,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "printers" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "connection" "PrinterConnection" NOT NULL,
    "host" TEXT,
    "port" INTEGER,
    "paper_width_mm" INTEGER NOT NULL DEFAULT 80,
    "last_seen_at" TIMESTAMPTZ(3),
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "printers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stations" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "mode" "StationMode" NOT NULL DEFAULT 'BOTH',
    "printer_id" UUID,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_groups" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sac_code" TEXT,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_components" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "tax_group_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "rate_bp" INTEGER NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "photos" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "items" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "short_code" TEXT,
    "description" TEXT,
    "photo_id" UUID,
    "base_price" INTEGER NOT NULL,
    "tax_group_id" UUID NOT NULL,
    "food_type" "FoodType" NOT NULL,
    "spice_level" INTEGER NOT NULL DEFAULT 0,
    "station_id" UUID NOT NULL,
    "prep_time_minutes" INTEGER,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "track_stock" BOOLEAN NOT NULL DEFAULT false,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "channels" "SalesChannel"[] DEFAULT ARRAY['POS', 'WAITER_APP', 'TABLE_TABLET', 'QR']::"SalesChannel"[],
    "repeatable" BOOLEAN NOT NULL DEFAULT false,
    "external_id" TEXT,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variants" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "external_id" TEXT,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modifier_groups" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "min_selections" INTEGER NOT NULL DEFAULT 0,
    "max_selections" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "modifier_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modifier_options" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "price_delta" INTEGER NOT NULL DEFAULT 0,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "modifier_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_modifier_groups" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_modifier_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "combos" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "active_from" DATE,
    "active_until" DATE,
    "window_start" TEXT,
    "window_end" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "combos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "combo_components" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "combo_id" UUID NOT NULL,
    "kind" "ComboComponentKind" NOT NULL,
    "item_id" UUID,
    "label" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "combo_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "combo_choice_options" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "component_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "combo_choice_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_tags" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "synonyms" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "synonyms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_levels" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_series" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "include_financial_year" BOOLEAN NOT NULL DEFAULT true,
    "separator" TEXT NOT NULL DEFAULT '/',
    "sequence_padding" INTEGER NOT NULL DEFAULT 6,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_sequences" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "series_id" UUID NOT NULL,
    "financial_year" TEXT NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_versions" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "published_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_by_id" UUID,
    "snapshot" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "menu_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "order_number" INTEGER NOT NULL,
    "order_type" "OrderType" NOT NULL,
    "source" "OrderSource" NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'OPEN',
    "table_session_id" UUID,
    "table_id" UUID,
    "takeaway_token" INTEGER,
    "created_by_id" UUID,
    "device_id" UUID,
    "customer_name" TEXT,
    "customer_phone" TEXT,
    "notes" TEXT,
    "external_ref" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "item_id" UUID NOT NULL,
    "variant_id" UUID,
    "parent_order_item_id" UUID,
    "name" TEXT NOT NULL,
    "variant_name" TEXT,
    "quantity" INTEGER NOT NULL,
    "unit_price" INTEGER NOT NULL,
    "line_total" INTEGER NOT NULL,
    "tax_group_id" UUID NOT NULL,
    "tax_rates" JSONB NOT NULL,
    "station_id" UUID NOT NULL,
    "state" "OrderItemState" NOT NULL,
    "instructions" TEXT,
    "created_by_id" UUID,
    "approved_by_id" UUID,
    "sent_at" TIMESTAMPTZ(3),
    "preparing_at" TIMESTAMPTZ(3),
    "ready_at" TIMESTAMPTZ(3),
    "picked_up_at" TIMESTAMPTZ(3),
    "served_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "end_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_item_modifiers" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "modifier_option_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "price_delta" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_item_modifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_events" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_item_id" UUID,
    "business_date" DATE NOT NULL,
    "type" TEXT NOT NULL,
    "from_state" "OrderItemState",
    "to_state" "OrderItemState",
    "actor_id" UUID,
    "device_id" UUID,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kots" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "kot_number" INTEGER NOT NULL,
    "order_id" UUID NOT NULL,
    "station_id" UUID NOT NULL,
    "kind" "KotKind" NOT NULL DEFAULT 'NEW',
    "print_status" "KotPrintStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "printed_at" TIMESTAMPTZ(3),
    "print_attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kot_lines" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "kot_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kot_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "action" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "order_id" UUID,
    "requested_by_id" UUID,
    "approved_by_id" UUID,
    "device_id" UUID,
    "reason" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "key" UUID NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status_code" INTEGER,
    "response" JSONB,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "invoice_date" DATE NOT NULL,
    "financial_year" TEXT NOT NULL,
    "series_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'ISSUED',
    "order_id" UUID,
    "table_session_id" UUID,
    "price_mode" "PriceMode" NOT NULL,
    "subtotal" INTEGER NOT NULL,
    "discount_total" INTEGER NOT NULL DEFAULT 0,
    "service_charge" INTEGER NOT NULL DEFAULT 0,
    "tax_total" INTEGER NOT NULL,
    "round_off" INTEGER NOT NULL DEFAULT 0,
    "grand_total" INTEGER NOT NULL,
    "customer_name" TEXT,
    "customer_gstin" TEXT,
    "customer_phone" TEXT,
    "issued_by_id" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMPTZ(3),
    "voided_at" TIMESTAMPTZ(3),
    "void_reason" TEXT,
    "replaces_invoice_id" UUID,
    "print_count" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "order_item_id" UUID,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price" INTEGER NOT NULL,
    "line_total" INTEGER NOT NULL,
    "discount" INTEGER NOT NULL DEFAULT 0,
    "taxable_value" INTEGER NOT NULL,
    "tax_group_id" UUID,
    "sac_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_lines" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "tax_group_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "rate_bp" INTEGER NOT NULL,
    "taxable_value" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discounts" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "invoice_id" UUID,
    "order_item_id" UUID,
    "kind" "DiscountKind" NOT NULL,
    "rate_bp" INTEGER,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "applied_by_id" UUID NOT NULL,
    "approved_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shifts" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "staff_id" UUID NOT NULL,
    "device_id" UUID,
    "status" "ShiftStatus" NOT NULL DEFAULT 'OPEN',
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(3),
    "opening_float" BIGINT NOT NULL,
    "expected_cash" BIGINT,
    "counted_cash" BIGINT,
    "variance" BIGINT,
    "denominations" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "invoice_id" UUID NOT NULL,
    "shift_id" UUID,
    "mode" "PaymentMode" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'CAPTURED',
    "amount" INTEGER NOT NULL,
    "tendered" INTEGER,
    "change" INTEGER,
    "reference" TEXT,
    "received_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_movements" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "shift_id" UUID NOT NULL,
    "direction" "CashDirection" NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "staff_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "day_ends" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "closed_by_id" UUID NOT NULL,
    "closed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "gross_sales" BIGINT NOT NULL,
    "discount_total" BIGINT NOT NULL,
    "tax_total" BIGINT NOT NULL,
    "net_sales" BIGINT NOT NULL,
    "report" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "day_ends_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" TEXT NOT NULL,
    "actor_id" UUID,
    "approver_id" UUID,
    "device_id" UUID,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "correlation_id" TEXT,
    "prev_hash" TEXT,
    "hash" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_version" INTEGER NOT NULL DEFAULT 1,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbox" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "settings_restaurant_id_idx" ON "settings"("restaurant_id");

-- CreateIndex
CREATE UNIQUE INDEX "settings_restaurant_id_key_key" ON "settings"("restaurant_id", "key");

-- CreateIndex
CREATE INDEX "business_days_restaurant_id_idx" ON "business_days"("restaurant_id");

-- CreateIndex
CREATE UNIQUE INDEX "business_days_restaurant_id_business_date_key" ON "business_days"("restaurant_id", "business_date");

-- CreateIndex
CREATE INDEX "daily_counters_restaurant_id_idx" ON "daily_counters"("restaurant_id");

-- CreateIndex
CREATE UNIQUE INDEX "daily_counters_restaurant_id_business_date_kind_key" ON "daily_counters"("restaurant_id", "business_date", "kind");

-- CreateIndex
CREATE INDEX "roles_restaurant_id_idx" ON "roles"("restaurant_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_restaurant_id_key_key" ON "roles"("restaurant_id", "key");

-- CreateIndex
CREATE INDEX "staff_restaurant_id_active_idx" ON "staff"("restaurant_id", "active");

-- CreateIndex
CREATE INDEX "credentials_restaurant_id_idx" ON "credentials"("restaurant_id");

-- CreateIndex
CREATE UNIQUE INDEX "credentials_staff_id_kind_key" ON "credentials"("staff_id", "kind");

-- CreateIndex
CREATE INDEX "devices_restaurant_id_status_idx" ON "devices"("restaurant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_restaurant_id_idx" ON "sessions"("restaurant_id");

-- CreateIndex
CREATE INDEX "sessions_staff_id_idx" ON "sessions"("staff_id");

-- CreateIndex
CREATE INDEX "sections_restaurant_id_idx" ON "sections"("restaurant_id");

-- CreateIndex
CREATE INDEX "tables_restaurant_id_idx" ON "tables"("restaurant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tables_restaurant_id_label_key" ON "tables"("restaurant_id", "label");

-- CreateIndex
CREATE INDEX "table_sessions_restaurant_id_business_date_idx" ON "table_sessions"("restaurant_id", "business_date");

-- CreateIndex
CREATE INDEX "table_sessions_table_id_status_idx" ON "table_sessions"("table_id", "status");

-- CreateIndex
CREATE INDEX "shift_assignments_restaurant_id_business_date_idx" ON "shift_assignments"("restaurant_id", "business_date");

-- CreateIndex
CREATE INDEX "categories_restaurant_id_idx" ON "categories"("restaurant_id");

-- CreateIndex
CREATE INDEX "printers_restaurant_id_idx" ON "printers"("restaurant_id");

-- CreateIndex
CREATE INDEX "stations_restaurant_id_idx" ON "stations"("restaurant_id");

-- CreateIndex
CREATE INDEX "tax_groups_restaurant_id_idx" ON "tax_groups"("restaurant_id");

-- CreateIndex
CREATE INDEX "tax_components_restaurant_id_idx" ON "tax_components"("restaurant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tax_components_tax_group_id_code_key" ON "tax_components"("tax_group_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "photos_storage_key_key" ON "photos"("storage_key");

-- CreateIndex
CREATE INDEX "photos_restaurant_id_idx" ON "photos"("restaurant_id");

-- CreateIndex
CREATE INDEX "items_restaurant_id_category_id_idx" ON "items"("restaurant_id", "category_id");

-- CreateIndex
CREATE INDEX "items_restaurant_id_external_id_idx" ON "items"("restaurant_id", "external_id");

-- CreateIndex
CREATE INDEX "variants_restaurant_id_idx" ON "variants"("restaurant_id");

-- CreateIndex
CREATE INDEX "variants_item_id_idx" ON "variants"("item_id");

-- CreateIndex
CREATE INDEX "modifier_groups_restaurant_id_idx" ON "modifier_groups"("restaurant_id");

-- CreateIndex
CREATE INDEX "modifier_options_restaurant_id_idx" ON "modifier_options"("restaurant_id");

-- CreateIndex
CREATE INDEX "modifier_options_group_id_idx" ON "modifier_options"("group_id");

-- CreateIndex
CREATE INDEX "item_modifier_groups_restaurant_id_idx" ON "item_modifier_groups"("restaurant_id");

-- CreateIndex
CREATE UNIQUE INDEX "item_modifier_groups_item_id_group_id_key" ON "item_modifier_groups"("item_id", "group_id");

-- CreateIndex
CREATE UNIQUE INDEX "combos_item_id_key" ON "combos"("item_id");

-- CreateIndex
CREATE INDEX "combos_restaurant_id_idx" ON "combos"("restaurant_id");

-- CreateIndex
CREATE INDEX "combo_components_restaurant_id_idx" ON "combo_components"("restaurant_id");

-- CreateIndex
CREATE INDEX "combo_components_combo_id_idx" ON "combo_components"("combo_id");

-- CreateIndex
CREATE INDEX "combo_choice_options_restaurant_id_idx" ON "combo_choice_options"("restaurant_id");

-- CreateIndex
CREATE UNIQUE INDEX "combo_choice_options_component_id_item_id_key" ON "combo_choice_options"("component_id", "item_id");

-- CreateIndex
CREATE INDEX "tags_restaurant_id_idx" ON "tags"("restaurant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tags_restaurant_id_name_key" ON "tags"("restaurant_id", "name");

-- CreateIndex
CREATE INDEX "item_tags_restaurant_id_idx" ON "item_tags"("restaurant_id");

-- CreateIndex
CREATE UNIQUE INDEX "item_tags_item_id_tag_id_key" ON "item_tags"("item_id", "tag_id");

-- CreateIndex
CREATE INDEX "synonyms_restaurant_id_idx" ON "synonyms"("restaurant_id");

-- CreateIndex
CREATE UNIQUE INDEX "synonyms_item_id_text_key" ON "synonyms"("item_id", "text");

-- CreateIndex
CREATE UNIQUE INDEX "stock_levels_item_id_key" ON "stock_levels"("item_id");

-- CreateIndex
CREATE INDEX "stock_levels_restaurant_id_idx" ON "stock_levels"("restaurant_id");

-- CreateIndex
CREATE INDEX "invoice_series_restaurant_id_idx" ON "invoice_series"("restaurant_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_series_restaurant_id_prefix_key" ON "invoice_series"("restaurant_id", "prefix");

-- CreateIndex
CREATE INDEX "invoice_sequences_restaurant_id_idx" ON "invoice_sequences"("restaurant_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_sequences_series_id_financial_year_key" ON "invoice_sequences"("series_id", "financial_year");

-- CreateIndex
CREATE INDEX "menu_versions_restaurant_id_idx" ON "menu_versions"("restaurant_id");

-- CreateIndex
CREATE UNIQUE INDEX "menu_versions_restaurant_id_version_key" ON "menu_versions"("restaurant_id", "version");

-- CreateIndex
CREATE INDEX "orders_table_session_id_idx" ON "orders"("table_session_id");

-- CreateIndex
CREATE INDEX "orders_restaurant_id_source_external_ref_idx" ON "orders"("restaurant_id", "source", "external_ref");

-- CreateIndex
CREATE UNIQUE INDEX "orders_restaurant_id_business_date_order_number_key" ON "orders"("restaurant_id", "business_date", "order_number");

-- CreateIndex
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");

-- CreateIndex
CREATE INDEX "order_items_restaurant_id_business_date_state_idx" ON "order_items"("restaurant_id", "business_date", "state");

-- CreateIndex
CREATE INDEX "order_items_station_id_state_idx" ON "order_items"("station_id", "state");

-- CreateIndex
CREATE INDEX "order_item_modifiers_restaurant_id_idx" ON "order_item_modifiers"("restaurant_id");

-- CreateIndex
CREATE INDEX "order_item_modifiers_order_item_id_idx" ON "order_item_modifiers"("order_item_id");

-- CreateIndex
CREATE INDEX "order_events_restaurant_id_idx" ON "order_events"("restaurant_id");

-- CreateIndex
CREATE INDEX "order_events_order_id_idx" ON "order_events"("order_id");

-- CreateIndex
CREATE INDEX "kots_restaurant_id_idx" ON "kots"("restaurant_id");

-- CreateIndex
CREATE INDEX "kots_order_id_idx" ON "kots"("order_id");

-- CreateIndex
CREATE INDEX "kots_station_id_business_date_idx" ON "kots"("station_id", "business_date");

-- CreateIndex
CREATE UNIQUE INDEX "kots_restaurant_id_business_date_kot_number_key" ON "kots"("restaurant_id", "business_date", "kot_number");

-- CreateIndex
CREATE INDEX "kot_lines_restaurant_id_idx" ON "kot_lines"("restaurant_id");

-- CreateIndex
CREATE INDEX "kot_lines_kot_id_idx" ON "kot_lines"("kot_id");

-- CreateIndex
CREATE INDEX "kot_lines_order_item_id_idx" ON "kot_lines"("order_item_id");

-- CreateIndex
CREATE INDEX "approvals_restaurant_id_status_idx" ON "approvals"("restaurant_id", "status");

-- CreateIndex
CREATE INDEX "approvals_order_id_idx" ON "approvals"("order_id");

-- CreateIndex
CREATE INDEX "idempotency_records_restaurant_id_idx" ON "idempotency_records"("restaurant_id");

-- CreateIndex
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_restaurant_id_scope_key_key" ON "idempotency_records"("restaurant_id", "scope", "key");

-- CreateIndex
CREATE INDEX "invoices_restaurant_id_business_date_idx" ON "invoices"("restaurant_id", "business_date");

-- CreateIndex
CREATE INDEX "invoices_table_session_id_idx" ON "invoices"("table_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_restaurant_id_invoice_number_key" ON "invoices"("restaurant_id", "invoice_number");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_series_id_financial_year_sequence_key" ON "invoices"("series_id", "financial_year", "sequence");

-- CreateIndex
CREATE INDEX "invoice_lines_restaurant_id_idx" ON "invoice_lines"("restaurant_id");

-- CreateIndex
CREATE INDEX "invoice_lines_invoice_id_idx" ON "invoice_lines"("invoice_id");

-- CreateIndex
CREATE INDEX "tax_lines_restaurant_id_idx" ON "tax_lines"("restaurant_id");

-- CreateIndex
CREATE INDEX "tax_lines_invoice_id_idx" ON "tax_lines"("invoice_id");

-- CreateIndex
CREATE INDEX "discounts_invoice_id_idx" ON "discounts"("invoice_id");

-- CreateIndex
CREATE INDEX "discounts_restaurant_id_business_date_idx" ON "discounts"("restaurant_id", "business_date");

-- CreateIndex
CREATE INDEX "shifts_restaurant_id_business_date_idx" ON "shifts"("restaurant_id", "business_date");

-- CreateIndex
CREATE INDEX "payments_invoice_id_idx" ON "payments"("invoice_id");

-- CreateIndex
CREATE INDEX "payments_restaurant_id_business_date_idx" ON "payments"("restaurant_id", "business_date");

-- CreateIndex
CREATE INDEX "cash_movements_restaurant_id_idx" ON "cash_movements"("restaurant_id");

-- CreateIndex
CREATE INDEX "cash_movements_shift_id_idx" ON "cash_movements"("shift_id");

-- CreateIndex
CREATE INDEX "day_ends_restaurant_id_idx" ON "day_ends"("restaurant_id");

-- CreateIndex
CREATE UNIQUE INDEX "day_ends_restaurant_id_business_date_key" ON "day_ends"("restaurant_id", "business_date");

-- CreateIndex
CREATE INDEX "audit_log_restaurant_id_business_date_idx" ON "audit_log"("restaurant_id", "business_date");

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_log_actor_id_idx" ON "audit_log"("actor_id");

-- CreateIndex
CREATE INDEX "outbox_restaurant_id_idx" ON "outbox"("restaurant_id");

-- CreateIndex
CREATE INDEX "outbox_published_at_occurred_at_idx" ON "outbox"("published_at", "occurred_at");

-- CreateIndex
CREATE INDEX "inbox_restaurant_id_idx" ON "inbox"("restaurant_id");

-- CreateIndex
CREATE UNIQUE INDEX "inbox_source_message_id_key" ON "inbox"("source", "message_id");

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "tables"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tables" ADD CONSTRAINT "tables_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stations" ADD CONSTRAINT "stations_printer_id_fkey" FOREIGN KEY ("printer_id") REFERENCES "printers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_components" ADD CONSTRAINT "tax_components_tax_group_id_fkey" FOREIGN KEY ("tax_group_id") REFERENCES "tax_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_tax_group_id_fkey" FOREIGN KEY ("tax_group_id") REFERENCES "tax_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "stations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variants" ADD CONSTRAINT "variants_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "modifier_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_modifier_groups" ADD CONSTRAINT "item_modifier_groups_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_modifier_groups" ADD CONSTRAINT "item_modifier_groups_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "modifier_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combos" ADD CONSTRAINT "combos_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combo_components" ADD CONSTRAINT "combo_components_combo_id_fkey" FOREIGN KEY ("combo_id") REFERENCES "combos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combo_components" ADD CONSTRAINT "combo_components_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combo_choice_options" ADD CONSTRAINT "combo_choice_options_component_id_fkey" FOREIGN KEY ("component_id") REFERENCES "combo_components"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combo_choice_options" ADD CONSTRAINT "combo_choice_options_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_tags" ADD CONSTRAINT "item_tags_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_tags" ADD CONSTRAINT "item_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "synonyms" ADD CONSTRAINT "synonyms_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_sequences" ADD CONSTRAINT "invoice_sequences_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "invoice_series"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_table_session_id_fkey" FOREIGN KEY ("table_session_id") REFERENCES "table_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "tables"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_parent_order_item_id_fkey" FOREIGN KEY ("parent_order_item_id") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_modifiers" ADD CONSTRAINT "order_item_modifiers_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_modifiers" ADD CONSTRAINT "order_item_modifiers_modifier_option_id_fkey" FOREIGN KEY ("modifier_option_id") REFERENCES "modifier_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kots" ADD CONSTRAINT "kots_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kots" ADD CONSTRAINT "kots_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "stations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kot_lines" ADD CONSTRAINT "kot_lines_kot_id_fkey" FOREIGN KEY ("kot_id") REFERENCES "kots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kot_lines" ADD CONSTRAINT "kot_lines_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "invoice_series"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_table_session_id_fkey" FOREIGN KEY ("table_session_id") REFERENCES "table_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_replaces_invoice_id_fkey" FOREIGN KEY ("replaces_invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_lines" ADD CONSTRAINT "tax_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

