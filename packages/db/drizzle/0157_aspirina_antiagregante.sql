-- La aspirina de todos los días es un antiagregante (B01AC06), no el analgésico (N02BA01) (revisión
-- del 25 nov): el código ya la reconoce por su nombre (`HABITUAL_MEDICATIONS`), y lo guardado antes se
-- completa con la misma regla que la 0150. Sin su código, la franja decía «Anticoagulante: aspirina»
-- y la exodoncia pedía el INR. También la que quedó con el código del grupo (B01A), de cuando se
-- confirmó como «anticoagulante» sin decir cuál era su código: solo se cambia por el exacto de su
-- misma clase. Lo escrito no cambia. Una prueba comprueba que esta lista y la del código digan lo mismo.
WITH standard_name(atc, name) AS (
  VALUES
    ('B01AC06', 'acido acetilsalicilico'),
    ('B01AC06', 'aspirina')
),
written AS (
  SELECT id, regexp_replace(btrim(public.search_fold(coalesce(generic_name, name))), '\s+', ' ', 'g') AS text
  FROM public.patient_medication
  WHERE atc_code IS NULL OR atc_code = 'B01A'
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
WHERE pm.id = found.id AND (pm.atc_code IS NULL OR pm.atc_code = 'B01A');
