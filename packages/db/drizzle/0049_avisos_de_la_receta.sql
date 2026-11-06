-- Los avisos que vio quien recetó al emitirla (alergia, embarazo, duplicado por ATC): la receta los
-- guarda con su nombre, sin pedirle un motivo (Q17 y X2 del QA del 2026-11-04). Nulo: sin avisos,
-- o una receta de antes.
ALTER TABLE "prescription" ADD COLUMN "alerts_seen" text[];
