-- Quién y cuándo dijo cada cosa (13 nov): lo que TS no declara. Las columnas `declarant_name`,
-- `declarant_relation` y `said_at` de `patient_health_declaration` las generó 0113; la tabla ya
-- tiene su RLS y su GRANT (0112), que valen para las columnas nuevas.

-- La salud que se declaró al registrarse ya está guardada, tal como llegó, en `patient_registration`.
-- Se copia como declaración para que lo que siga sin revisar diga de quién es y de cuándo: sus filas
-- de Antecedentes entraron en la misma transacción que el registro, así que comparten `created_at`.
-- Quien habló por la persona es quien escribió el formulario; un registro que no dice quién respondió
-- (los de antes) no se copia: la ficha no afirma un autor que no consta.
INSERT INTO public.patient_health_declaration
  (organization_id, patient_id, via, respondent, declarant_name, declarant_relation, health, said_at, created_at)
SELECT r.organization_id, r.patient_id, 'registro', r.respondent,
  CASE WHEN r.respondent = 'representative' THEN nullif(btrim(r.answers #>> '{representative,displayName}'), '') END,
  CASE WHEN r.respondent = 'representative' THEN nullif(lower(btrim(r.answers #>> '{representative,relationshipDetail}')), '') END,
  r.answers -> 'health', r.created_at, r.created_at
FROM public.patient_registration r
WHERE r.respondent IN ('patient', 'representative', 'staff')
  AND jsonb_typeof(r.answers -> 'health') = 'object'
  AND NOT EXISTS (
    SELECT 1 FROM public.patient_health_declaration d
    WHERE d.organization_id = r.organization_id AND d.patient_id = r.patient_id AND d.created_at = r.created_at
  );
