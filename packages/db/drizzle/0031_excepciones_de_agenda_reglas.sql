-- Una persona del equipo puede dar dos citas a la misma hora con un profesional:
-- la cita que acepta esa excepción no entra en la exclusión del profesional. Dos
-- citas normales siguen sin poder pisarse, y la exclusión de la unidad no cambia.
ALTER TABLE ONLY public.appointment DROP CONSTRAINT appointment_no_overlap_professional;--> statement-breakpoint
ALTER TABLE ONLY public.appointment
    ADD CONSTRAINT appointment_no_overlap_professional EXCLUDE USING gist (organization_id WITH =, professional_user_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE ((status = ANY (ARRAY['programada'::text, 'confirmada'::text])) AND NOT is_test AND NOT overlap_allowed);
