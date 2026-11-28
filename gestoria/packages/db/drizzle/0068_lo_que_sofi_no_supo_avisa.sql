-- Lo que Sofi no supo avisa al celular (lienzo «La ficha del producto», tablero 12): un tipo más
-- de aviso, «preguntas», y hasta dónde miró el sistema (`questions_seen`, como `chats_seen`).
ALTER TABLE "push_choice" DROP CONSTRAINT "push_choice_kinds_check";--> statement-breakpoint
ALTER TABLE "push_choice" ADD COLUMN "questions_seen" uuid[];--> statement-breakpoint
ALTER TABLE "push_choice" ADD CONSTRAINT "push_choice_kinds_check" CHECK ("push_choice"."kinds" is null or "push_choice"."kinds" <@ array['pagos','chats','no_entregado','sofi_pedido','dinero','preguntas']::text[]);