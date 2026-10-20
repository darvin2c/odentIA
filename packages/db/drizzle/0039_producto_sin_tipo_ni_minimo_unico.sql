ALTER TABLE "product" DROP CONSTRAINT "product_kind_check";--> statement-breakpoint
ALTER TABLE "product" DROP CONSTRAINT "product_min_stock_check";--> statement-breakpoint
ALTER TABLE "product" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "product" DROP COLUMN "min_stock";