ALTER TABLE "task" ADD COLUMN "relationship_detail" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "kinship" text;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_relationship_detail_check" CHECK (length("task"."relationship_detail") <= 100);--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_kinship_check" CHECK ("task"."kinship" IS NULL OR "task"."kinship" IN ('MTH','FTH','CHILD','SPS','DOMPART','SIB','MGRPRN','PGRPRN','GRNDCHILD','AUNT','UNCLE','COUSN','FAMMEMB','FRND','NBOR'));--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_relationship_kind_check" CHECK (("task"."relationship_detail" IS NULL AND "task"."kinship" IS NULL) OR "task"."kind" = 'confirmar_representante');--> statement-breakpoint
-- A mano (la clase de tarea es un CHECK de 0001_base_reglas.sql, no del esquema
-- TS): lo que deja un registro desde fuera tiene su propia clase, en vez de
-- `ficha_repetida` con un prefijo en su clave. Las de la semilla anterior se
-- pasan a su clase antes de exigirla.
ALTER TABLE public.task DROP CONSTRAINT task_kind_check;--> statement-breakpoint
UPDATE public.task SET kind = 'registro_con_documento' WHERE kind = 'ficha_repetida' AND idempotency_key LIKE 'registro-con-documento:%';--> statement-breakpoint
UPDATE public.task SET kind = 'confirmar_representante' WHERE kind = 'ficha_repetida' AND idempotency_key LIKE 'confirmar-representante:%';--> statement-breakpoint
ALTER TABLE public.task ADD CONSTRAINT task_kind_check CHECK (((kind IS NULL) OR (kind = ANY (ARRAY['ficha_repetida'::text, 'volver_al_portal'::text, 'registro_con_documento'::text, 'confirmar_representante'::text]))));
