CREATE TABLE "catalog"."procedure_code_product" (
	"system_key" text NOT NULL,
	"code" text NOT NULL,
	"product" text NOT NULL,
	CONSTRAINT "procedure_code_product_system_key_product_code_pk" PRIMARY KEY("system_key","product","code")
);
--> statement-breakpoint
ALTER TABLE "catalog"."procedure_code" ADD COLUMN "section" text;--> statement-breakpoint
ALTER TABLE "catalog"."procedure_code_product" ADD CONSTRAINT "procedure_code_product_system_key_procedure_code_system_key_fk" FOREIGN KEY ("system_key") REFERENCES "catalog"."procedure_code_system"("key") ON DELETE no action ON UPDATE no action;