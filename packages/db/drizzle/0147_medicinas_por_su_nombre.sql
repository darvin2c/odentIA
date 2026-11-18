-- Las medicinas escritas a mano antes de reconocer sus nombres estándar (reglas clínicas del 18 nov):
-- la que empieza por la DCI, el nombre local o la marca registrada de un anticoagulante, un
-- antiagregante o una medicina para los huesos de la lista habitual («alendronato 70 mg semanal»,
-- «Eliquis 5 mg») recibe el código ATC de su DCI, el mismo que le da hoy `matchHabitualMedication` al
-- guardarla. Sin él, la franja seguía diciendo «no se le preguntó» y la cirugía no avisaba. Lo
-- escrito no cambia (nombre, DCI escrita y dosis quedan como estaban): solo se llena el código que
-- faltaba, nunca se cambia uno puesto. Los nombres son los de `HABITUAL_MEDICATIONS`
-- (`@odentia/clinical`), ya sin tildes ni mayúsculas, como los compara `normalizeDrugText`; una
-- prueba comprueba que esta lista y la del código digan lo mismo. Se reconoce el nombre entero al
-- principio, seguido de lo que no es una letra: «ácido» o «alendro» solos no. Una combinación no es
-- su primera medicina («alendronato + colecalciferol», «Eliquis/aspirina», «Prolia y calcio»): lo que
-- sigue al nombre se mira con la misma regla que `COMPOUND_REST` del código.
-- `patient_health_declaration` no se toca: guarda lo que la persona dijo, tal como llegó.
WITH standard_name(atc, name) AS (
  VALUES
    ('B01AA03', 'warfarina'),
    ('B01AA07', 'acenocumarol'),
    ('B01AA07', 'sintrom'),
    ('B01AB05', 'enoxaparina'),
    ('B01AC04', 'clopidogrel'),
    ('B01AC04', 'plavix'),
    ('B01AE07', 'dabigatran etexilato'),
    ('B01AE07', 'dabigatran'),
    ('B01AE07', 'pradaxa'),
    ('B01AF01', 'rivaroxaban'),
    ('B01AF01', 'xarelto'),
    ('B01AF02', 'apixaban'),
    ('B01AF02', 'eliquis'),
    ('M05BA04', 'acido alendronico'),
    ('M05BA04', 'alendronato'),
    ('M05BA04', 'alendronato sodico'),
    ('M05BA04', 'fosamax'),
    ('M05BA07', 'acido risedronico'),
    ('M05BA07', 'risedronato'),
    ('M05BA07', 'risedronato sodico'),
    ('M05BA07', 'actonel'),
    ('M05BA06', 'acido ibandronico'),
    ('M05BA06', 'ibandronato'),
    ('M05BA06', 'bonviva'),
    ('M05BA08', 'acido zoledronico'),
    ('M05BA08', 'zoledronato'),
    ('M05BA08', 'aclasta'),
    ('M05BA08', 'zometa'),
    ('M05BA03', 'acido pamidronico'),
    ('M05BA03', 'pamidronato'),
    ('M05BA03', 'aredia'),
    ('M05BX04', 'denosumab'),
    ('M05BX04', 'prolia'),
    ('M05BX04', 'xgeva'),
    ('M05BX06', 'romosozumab'),
    ('M05BX06', 'evenity')
),
written AS (
  SELECT id, regexp_replace(btrim(public.search_fold(coalesce(generic_name, name))), '\s+', ' ', 'g') AS text
  FROM public.patient_medication
  WHERE atc_code IS NULL
),
found AS (
  SELECT DISTINCT ON (w.id) w.id, s.atc
  FROM written w
  JOIN standard_name s
    ON left(w.text, length(s.name)) = s.name
   AND substr(w.text, length(s.name) + 1, 1) !~ '[[:alpha:]]'
   AND substr(w.text, length(s.name) + 1) !~ '\+|^\s*/\s*[[:alpha:]]|^\s*([0-9.,]+\s*(mg|g|mcg|ug|ml|ui|%)?\s*)?\m[ye]\M\s*[[:alpha:]]'
  ORDER BY w.id, length(s.name) DESC
)
UPDATE public.patient_medication pm
SET atc_code = found.atc
FROM found
WHERE pm.id = found.id AND pm.atc_code IS NULL;
