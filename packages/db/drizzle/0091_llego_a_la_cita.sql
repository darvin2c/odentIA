-- «Llegó» como hecho con hora (ADR 0032): la cita anota cuándo llegó la persona
-- y quién lo marcó. No es un estado nuevo: los cinco estados y la exclusión de
-- solapamientos no cambian, así que llegar no cambia lo que ocupa la cita.
-- Solo una cita en pie confirmada o ya atendida puede tener llegada; marcarla
-- confirma la que estaba por confirmar (lo hace el servicio).
ALTER TABLE "appointment" ADD COLUMN "arrived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "arrived_by" text;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_arrived_by_user_id_fk" FOREIGN KEY ("arrived_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_arrival_check" CHECK ("appointment"."arrived_at" IS NULL OR "appointment"."status" IN ('confirmada','atendida'));--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_arrival_pair_check" CHECK (("appointment"."arrived_at" IS NULL) = ("appointment"."arrived_by" IS NULL));
