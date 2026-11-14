-- Preguntas al paciente (mesa del 13 nov, entrega 6): lo que TS no declara. La columna
-- `questions_version` de `patient_registration_config` la generó 0119; la tabla ya tiene su RLS y
-- su GRANT, que valen para la columna nueva. Las clínicas que ya existían quedan en la versión 1:
-- así su administración recibe el aviso de que hay preguntas nuevas.

-- La lactancia, el tabaco y el alcohol eran preguntas solo de latidIA. Una clínica dental las tiene guardadas
-- como «no se pide» sin que nadie lo decidiera (su pantalla nunca las mostró). Ahora también son
-- suyas y, como las demás preguntas nuevas, nacen en «Opcional»: las otras no hace falta tocarlas,
-- porque su configuración guardada no las nombra y toman el valor por defecto al leerla.
UPDATE public.patient_registration_config c
SET fields = c.fields || '{"medical.lactancia":"optional","medical.tabaco":"optional","medical.alcohol":"optional"}'::jsonb
WHERE COALESCE(
  (SELECT p.product FROM public.org_profile p WHERE p.organization_id = c.organization_id),
  'dental'
) = 'dental';
