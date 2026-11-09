ALTER TABLE "catalog"."dental_template_rule" ADD COLUMN "tooth_groups" text[];--> statement-breakpoint
ALTER TABLE "catalog"."dental_template_rule" ADD COLUMN "dentition" text;--> statement-breakpoint
ALTER TABLE "catalog"."dental_template_rule" ADD COLUMN "family" text;--> statement-breakpoint
ALTER TABLE "catalog"."dental_template_rule" ADD CONSTRAINT "dental_template_rule_anatomy_check" CHECK (("catalog"."dental_template_rule"."tooth_groups" IS NULL AND "catalog"."dental_template_rule"."family" IS NULL AND "catalog"."dental_template_rule"."dentition" IS NULL)
        OR ("catalog"."dental_template_rule"."family" IS NOT NULL AND cardinality("catalog"."dental_template_rule"."tooth_groups") > 0
          AND "catalog"."dental_template_rule"."tooth_groups" <@ ARRAY['anterior', 'premolar', 'molar']::text[]
          AND ("catalog"."dental_template_rule"."dentition" IS NULL OR "catalog"."dental_template_rule"."dentition" IN ('permanent', 'deciduous'))));