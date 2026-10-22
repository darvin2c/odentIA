-- El plan ya no limita sedes ni personas (ADR 0031, issue 104): se van los
-- disparadores que contaban el cupo antes de las columnas que leían.
DROP TRIGGER IF EXISTS saas_branch_cap_activate ON public.branch;--> statement-breakpoint
DROP TRIGGER IF EXISTS saas_branch_cap_insert ON public.branch;--> statement-breakpoint
DROP TRIGGER IF EXISTS saas_seat_cap_invitation ON public.invitation;--> statement-breakpoint
DROP TRIGGER IF EXISTS saas_seat_cap_member ON public.member;--> statement-breakpoint
DROP FUNCTION IF EXISTS public.saas_branch_cap_check();--> statement-breakpoint
DROP FUNCTION IF EXISTS public.saas_seat_cap_check();--> statement-breakpoint
ALTER TABLE "admin"."saas_plan" DROP CONSTRAINT "saas_plan_limits_check";--> statement-breakpoint
ALTER TABLE "admin"."saas_plan" DROP COLUMN "max_branches";--> statement-breakpoint
ALTER TABLE "admin"."saas_plan" DROP COLUMN "max_seats";
