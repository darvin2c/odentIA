-- Los temas que ya estaban abiertos pasan a «Ahora» a las dos horas de reloj
-- de haberse creado, como contaba la Bandeja hasta ahora; los nuevos cuentan
-- solo las horas de clínica abierta (decisión 1 del pulido de la Bandeja).
UPDATE "agent_handoff" SET "urgent_at" = "created_at" + interval '2 hours' WHERE "urgent_at" IS NULL;
