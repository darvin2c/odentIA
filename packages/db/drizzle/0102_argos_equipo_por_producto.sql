-- El rol de quien atiende, en la vista del equipo de Argos, es el del producto (issue 229, entrega 9):
-- «odontología» en odentIA y «medicina» en latidIA. Las columnas son las mismas, en el mismo orden.
CREATE OR REPLACE VIEW argos.equipo AS
SELECT u.name AS profesional,
  array_to_string(ARRAY(SELECT CASE trim(r) WHEN 'owner' THEN 'propietario' WHEN 'admin' THEN 'administración'
    WHEN 'clinician' THEN CASE WHEN op.product = 'medical' THEN 'medicina' ELSE 'odontología' END
    WHEN 'reception' THEN 'recepción' WHEN 'cashier' THEN 'caja' ELSE 'otro' END FROM unnest(string_to_array(m.role, ',')) r), ', ') AS rol,
  (SELECT string_agg(s.name, ', ' ORDER BY s.name) FROM public.professional_specialty ps
    JOIN public.org_specialty s ON s.organization_id = ps.organization_id AND s.id = ps.specialty_id
    WHERE ps.organization_id = m.organization_id AND ps.user_id = m.user_id) AS especialidades,
  (EXISTS (SELECT 1 FROM public.professional_schedule s WHERE s.organization_id = m.organization_id AND s.professional_user_id = m.user_id)
    OR EXISTS (SELECT 1 FROM public.appointment a WHERE a.organization_id = m.organization_id AND a.professional_user_id = m.user_id)) AS atiende
FROM public.member m
JOIN auth."user" u ON u.id = m.user_id
LEFT JOIN public.org_profile op ON op.organization_id = m.organization_id
WHERE m.organization_id = NULLIF(current_setting('app.org_id', true), '');
