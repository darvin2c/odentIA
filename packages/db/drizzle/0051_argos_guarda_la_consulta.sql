ALTER TABLE "report_question" DROP CONSTRAINT "report_question_outcome_check";--> statement-breakpoint
ALTER TABLE "report_question" ADD COLUMN "query" text;--> statement-breakpoint
ALTER TABLE "report_question" ADD CONSTRAINT "report_question_outcome_check" CHECK ("report_question"."outcome" in ('respondida','parcial','pregunta','no_sabe','clinico','accion','ayuda','otro','no_pudo'));