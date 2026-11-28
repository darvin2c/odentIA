-- La pasarela con las claves de la tienda (Cobros; ADR 0232): además de entrar a la cuenta de
-- Mercado Pago con la aplicación de gestorIA, la tienda puede pegar el Access Token de su propia
-- aplicación. `connected_with` dice cómo se conectó; `checked_at`, cuándo se preguntó a Mercado
-- Pago por última vez si reconoce el token pegado (no vence ni se renueva).
ALTER TABLE "store_payment_link" ADD COLUMN "connected_with" text DEFAULT 'cuenta' NOT NULL;--> statement-breakpoint
ALTER TABLE "store_payment_link" ADD COLUMN "checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "store_payment_link" ADD CONSTRAINT "store_payment_link_connected_with_check" CHECK (connected_with IN ('cuenta','claves'));--> statement-breakpoint
-- Las conexiones de antes sin `refresh_token` ni vencimiento son tokens pegados a mano: claves de
-- la tienda. Las que entraron a la cuenta siempre vencen.
UPDATE "store_payment_link" SET "connected_with" = 'claves'
  WHERE "refresh_token_enc" IS NULL AND "expires_at" IS NULL;
