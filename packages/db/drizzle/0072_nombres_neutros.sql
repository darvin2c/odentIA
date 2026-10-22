-- Nombres neutros para lo común (ADR 0079): el profesional que atiende, la
-- sala de la sede y la lista de espera. Generada con drizzle-kit; índices,
-- llaves y checks se renombran en vez de borrarse y crearse, porque las llaves
-- compuestas de la 0001 dependen de los índices únicos (mismo estado final).
ALTER TABLE "schedule_chair" RENAME TO "schedule_room";--> statement-breakpoint
ALTER TABLE "appointment" RENAME COLUMN "dentist_user_id" TO "professional_user_id";--> statement-breakpoint
ALTER TABLE "appointment" RENAME COLUMN "chair_id" TO "room_id";--> statement-breakpoint
ALTER TABLE "professional_schedule" RENAME COLUMN "dentist_user_id" TO "professional_user_id";--> statement-breakpoint
ALTER TABLE "schedule_block" RENAME COLUMN "dentist_user_id" TO "professional_user_id";--> statement-breakpoint
ALTER TABLE "schedule_block" RENAME COLUMN "chair_id" TO "room_id";--> statement-breakpoint
ALTER TABLE "encounter" RENAME COLUMN "dentist_user_id" TO "professional_user_id";--> statement-breakpoint
ALTER TABLE "encounter_dictation_suggestion" RENAME COLUMN "dentist_user_id" TO "professional_user_id";--> statement-breakpoint
ALTER TABLE "admin"."saas_waitlist_request" RENAME COLUMN "dentists" TO "professionals";--> statement-breakpoint
ALTER TABLE "admin"."saas_waitlist_request" RENAME CONSTRAINT "saas_waitlist_request_dentists_check" TO "saas_waitlist_request_professionals_check";--> statement-breakpoint
ALTER TABLE "appointment" RENAME CONSTRAINT "appointment_dentist_user_id_user_id_fk" TO "appointment_professional_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "appointment" RENAME CONSTRAINT "appointment_chair_id_schedule_chair_id_fk" TO "appointment_room_id_schedule_room_id_fk";--> statement-breakpoint
ALTER TABLE "schedule_room" RENAME CONSTRAINT "schedule_chair_organization_id_organization_id_fk" TO "schedule_room_organization_id_organization_id_fk";--> statement-breakpoint
ALTER TABLE "schedule_room" RENAME CONSTRAINT "schedule_chair_branch_id_branch_id_fk" TO "schedule_room_branch_id_branch_id_fk";--> statement-breakpoint
ALTER TABLE "professional_schedule" RENAME CONSTRAINT "professional_schedule_dentist_user_id_user_id_fk" TO "professional_schedule_professional_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "schedule_block" RENAME CONSTRAINT "schedule_block_dentist_user_id_user_id_fk" TO "schedule_block_professional_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "schedule_block" RENAME CONSTRAINT "schedule_block_chair_id_schedule_chair_id_fk" TO "schedule_block_room_id_schedule_room_id_fk";--> statement-breakpoint
ALTER TABLE "encounter" RENAME CONSTRAINT "encounter_dentist_user_id_user_id_fk" TO "encounter_professional_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "encounter_dictation_suggestion" RENAME CONSTRAINT "encounter_dictation_suggestion_dentist_user_id_user_id_fk" TO "encounter_dictation_suggestion_professional_user_id_user_id_fk";--> statement-breakpoint
ALTER INDEX "appointment_org_dentist_range_idx" RENAME TO "appointment_org_professional_range_idx";--> statement-breakpoint
ALTER INDEX "schedule_chair_org_id_uidx" RENAME TO "schedule_room_org_id_uidx";--> statement-breakpoint
ALTER INDEX "schedule_chair_org_branch_idx" RENAME TO "schedule_room_org_branch_idx";--> statement-breakpoint
ALTER INDEX "professional_schedule_org_branch_dentist_idx" RENAME TO "professional_schedule_org_branch_professional_idx";
