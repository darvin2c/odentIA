-- Antes de cada cita, en una sola tarjeta (mesa de formularios del 13 nov, entrega 8): lo que TS no
-- declara. La tabla `appointment_visit_answer` (una respuesta por cita) la generó 0117.

-- Lo que la persona cuenta de su visita es de la clínica, con su RLS. La aplicación lo agrega y lo
-- lee; de lo enviado solo anota, una vez, quién lo vio al atender (ADR 0063).
ALTER TABLE public.appointment_visit_answer ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.appointment_visit_answer FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.appointment_visit_answer USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
REVOKE ALL ON TABLE public.appointment_visit_answer FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.appointment_visit_answer TO dentalagent_app;--> statement-breakpoint
GRANT UPDATE (seen_by, seen_at, seen_encounter_id) ON TABLE public.appointment_visit_answer TO dentalagent_app;--> statement-breakpoint

-- Un borrador vacío se descarta de un toque y nada lo frena: si en él se vio lo que contó, la
-- atención se suelta y quién lo vio y cuándo se quedan (solo esa columna pasa a nula).
ALTER TABLE public.appointment_visit_answer DROP CONSTRAINT appointment_visit_answer_seen_encounter_fk;--> statement-breakpoint
ALTER TABLE public.appointment_visit_answer ADD CONSTRAINT appointment_visit_answer_seen_encounter_fk
  FOREIGN KEY (organization_id, patient_id, seen_encounter_id)
  REFERENCES public.encounter (organization_id, patient_id, id) ON DELETE SET NULL (seen_encounter_id);--> statement-breakpoint

-- Lo que la persona envió queda como llegó (NTS 139-MINSA/2018/DGAIN, 5.3.3: nada se elimina y la
-- corrección es un registro nuevo). Lo único que cambia es quién lo vio al atender, una sola vez;
-- después, solo soltar la atención descartada.
CREATE OR REPLACE FUNCTION public.appointment_visit_answer_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
    OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id
    OR NEW.reason IS DISTINCT FROM OLD.reason
    OR NEW.pain IS DISTINCT FROM OLD.pain
    OR NEW.pain_level IS DISTINCT FROM OLD.pain_level
    OR NEW.more IS DISTINCT FROM OLD.more
    OR NEW.told_purpose IS DISTINCT FROM OLD.told_purpose
    OR NEW.respondent_contact_id IS DISTINCT FROM OLD.respondent_contact_id
    OR NEW.submitted_via IS DISTINCT FROM OLD.submitted_via
    OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
    RAISE EXCEPTION 'Lo que contó antes de su cita no se cambia (%)', OLD.id USING ERRCODE = '25001';
  END IF;
  IF OLD.seen_at IS NOT NULL AND (
    NEW.seen_at IS DISTINCT FROM OLD.seen_at
    OR NEW.seen_by IS DISTINCT FROM OLD.seen_by
    OR (NEW.seen_encounter_id IS DISTINCT FROM OLD.seen_encounter_id AND NEW.seen_encounter_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'Quién lo vio al atender ya está anotado (%)', OLD.id USING ERRCODE = '25001';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER appointment_visit_answer_guard BEFORE UPDATE ON public.appointment_visit_answer
  FOR EACH ROW EXECUTE FUNCTION public.appointment_visit_answer_guard();--> statement-breakpoint

-- El «Cuestionario previo a la cita» y cualquier otro formulario que respondía el paciente se dejan
-- de usar: lo que se le pregunta antes de cada cita está en «Preguntas al paciente». Lo publicado se
-- retira; lo ya respondido no se toca, y lo enviado sin revisar sigue en su ficha por revisar.
UPDATE public.clinical_form_template
SET status = 'archivado', updated_at = now()
WHERE respondent = 'portal' AND status = 'publicado';--> statement-breakpoint

-- Lo que alguien dejó a medias en su portal y nunca envió ya no tiene dónde terminarse: se descarta
-- con su motivo. No era una declaración (nunca la envió) y no se borra.
UPDATE public.clinical_form_response
SET status = 'descartado',
  discarded_at = now(),
  discard_reason = 'Lo dejó a medias en su portal y no lo envió. Lo que se pregunta antes de cada cita está ahora en «Antes de tu cita».',
  updated_at = now()
WHERE source = 'portal' AND status = 'borrador' AND submitted_at IS NULL;
