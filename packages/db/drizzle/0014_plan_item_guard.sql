--> 0014 nivelación del corte plan/presupuesto para bases que aplicaron 0013
--> antes de su redacción final: budget_id nullable en el ítem (el presupuesto
--> vigente puede faltar) y policy de borrado con regla de presupuesto no
--> borrador. En instalaciones nuevas 0013 ya deja este estado: ambas
--> sentencias son idempotentes y no cambian su resultado.
ALTER TABLE "treatment_plan_item" ALTER COLUMN "budget_id" DROP NOT NULL;--> statement-breakpoint
DROP POLICY IF EXISTS "plan_item_delete_guard" ON "treatment_plan_item";--> statement-breakpoint
CREATE POLICY "plan_item_delete_guard" ON "treatment_plan_item" AS RESTRICTIVE FOR DELETE
  USING ("status" = 'pendiente'
    AND NOT EXISTS (SELECT 1 FROM "treatment_budget_item" WHERE "treatment_budget_item"."plan_item_id" = "treatment_plan_item"."id")
    AND NOT EXISTS (SELECT 1 FROM "encounter_procedure" WHERE "encounter_procedure"."plan_item_id" = "treatment_plan_item"."id")
    AND NOT EXISTS (SELECT 1 FROM "encounter_plan_item" WHERE "encounter_plan_item"."plan_item_id" = "treatment_plan_item"."id")
    AND ("treatment_plan_item"."budget_id" IS NULL OR NOT EXISTS (
      SELECT 1 FROM "treatment_budget"
      WHERE "treatment_budget"."id" = "treatment_plan_item"."budget_id"
        AND "treatment_budget"."status" <> 'borrador'
    ))
  );
