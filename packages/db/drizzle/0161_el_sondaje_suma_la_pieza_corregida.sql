-- Las piezas de un periodontograma se fijan al empezarlo con el odontograma de ese momento, pero si
-- el odontólogo lo corrige durante el sondaje (la pieza no estaba ausente), esa pieza se sondea y se
-- suma (revisión del 26 nov): el odontograma lo decide él, no la foto del comienzo. Las piezas y los
-- implantes solo crecen; quitar una, o cambiar lo demás de la cabecera, sigue sin poderse.
CREATE OR REPLACE FUNCTION public.guard_periodontal_draft() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  encounter_status text;
BEGIN
  IF TG_TABLE_NAME = 'periodontal_chart' THEN
    IF TG_OP = 'UPDATE' AND (
      (NEW.organization_id, NEW.patient_id, NEW.encounter_id, NEW.created_by, NEW.created_at)
        IS DISTINCT FROM (OLD.organization_id, OLD.patient_id, OLD.encounter_id, OLD.created_by, OLD.created_at)
      OR NOT (OLD.expected_teeth <@ NEW.expected_teeth)
      OR NOT (OLD.implant_teeth <@ NEW.implant_teeth)
      OR NOT (NEW.implant_teeth <@ NEW.expected_teeth)
    ) THEN
      RAISE EXCEPTION 'Las piezas de un periodontograma se fijan al empezarlo: solo se suma la que el odontograma ya no tiene ausente' USING ERRCODE = '23514', CONSTRAINT = 'periodontal_draft_only';
    END IF;
    SELECT e.status INTO encounter_status FROM encounter e
      WHERE e.id = NEW.encounter_id AND e.organization_id = NEW.organization_id;
  ELSE
    IF TG_OP = 'UPDATE' AND (NEW.organization_id, NEW.chart_id, NEW.tooth_number, NEW.created_at)
      IS DISTINCT FROM (OLD.organization_id, OLD.chart_id, OLD.tooth_number, OLD.created_at) THEN
      RAISE EXCEPTION 'Una pieza del periodontograma no cambia de periodontograma ni de número' USING ERRCODE = '23514', CONSTRAINT = 'periodontal_draft_only';
    END IF;
    SELECT e.status INTO encounter_status FROM periodontal_chart c
      JOIN encounter e ON e.organization_id = c.organization_id AND e.id = c.encounter_id
      WHERE c.id = NEW.chart_id AND c.organization_id = NEW.organization_id;
  END IF;
  IF encounter_status IS DISTINCT FROM 'borrador' THEN
    RAISE EXCEPTION 'El periodontograma de una atención cerrada no se modifica: registra una adenda' USING ERRCODE = '23514', CONSTRAINT = 'periodontal_draft_only';
  END IF;
  RETURN NEW;
END;
$$;
