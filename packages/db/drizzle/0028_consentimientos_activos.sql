-- Un consentimiento publicado o archivado no cambia su texto, pero se puede
-- apagar y volver a encender, y quien lo lee queda anotado sin crear otra versión.
CREATE OR REPLACE FUNCTION public.clinical_forms_consent_template_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.status IN ('publicado','archivado') THEN
    IF NEW.status IN ('publicado','archivado')
      AND (to_jsonb(NEW) - ARRAY['status','updated_at','published_at','reviewed_at','reviewed_by'])
        = (to_jsonb(OLD) - ARRAY['status','updated_at','published_at','reviewed_at','reviewed_by'])
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Consentimiento % inmutable (%)', OLD.status, OLD.id USING ERRCODE = '25001';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- Lo que una clínica ya publicó, alguien de ella lo revisó.
UPDATE "consent_template" SET "reviewed_at" = COALESCE("published_at", "updated_at"), "reviewed_by" = "created_by" WHERE "status" IN ('publicado','archivado');--> statement-breakpoint
-- Las clínicas de hoy quedan como las nuevas: con lo sugerido activo y sin revisar.
-- Es la foto de los textos de este momento: una clínica nueva los toma del código.
CREATE TEMPORARY TABLE consent_suggestion (product text, key text, title text, sections jsonb, body text, prefixes text[]) ON COMMIT DROP;--> statement-breakpoint
INSERT INTO consent_suggestion VALUES
  ('dental', 'anestesia-local', $s$Anestesia local odontológica$s$, $s${"procedure":"Aplicación de anestésico local por infiltración o bloqueo troncular para realizar el tratamiento dental sin dolor.","benefits":["Realizar el tratamiento sin dolor","Mayor comodidad durante la atención"],"risks":["Adormecimiento de labio, lengua o mejilla por varias horas","Dolor o hematoma en el sitio de punción","Mordedura accidental de la zona adormecida","Reacción alérgica o malestar general, poco frecuentes","Alteración temporal de la sensibilidad, rara vez prolongada"],"alternatives":["Realizar el procedimiento sin anestesia, cuando sea posible","Sedación en un centro autorizado"],"consequences":"Algunos procedimientos no pueden realizarse sin anestesia por el dolor que producen."}$s$::jsonb, $s$Procedimiento propuesto
Aplicación de anestésico local por infiltración o bloqueo troncular para realizar el tratamiento dental sin dolor.

Beneficios esperados
• Realizar el tratamiento sin dolor
• Mayor comodidad durante la atención

Riesgos y molestias
• Adormecimiento de labio, lengua o mejilla por varias horas
• Dolor o hematoma en el sitio de punción
• Mordedura accidental de la zona adormecida
• Reacción alérgica o malestar general, poco frecuentes
• Alteración temporal de la sensibilidad, rara vez prolongada

Alternativas
• Realizar el procedimiento sin anestesia, cuando sea posible
• Sedación en un centro autorizado

Consecuencias de no tratarse
Algunos procedimientos no pueden realizarse sin anestesia por el dolor que producen.$s$, ARRAY[]::text[]),
  ('dental', 'exodoncia', $s$Exodoncia simple o quirúrgica$s$, $s${"procedure":"Extracción de la pieza dentaria indicada con anestesia local; puede requerir separar la encía, retirar hueso, dividir la pieza y suturar.","benefits":["Eliminar el foco de infección y el dolor","Evitar daño a las piezas vecinas"],"risks":["Dolor, inflamación y limitación de la apertura bucal por algunos días","Sangrado, infección o alveolitis (inflamación del alvéolo)","Alteración de la sensibilidad del labio o la lengua, generalmente temporal","Fractura de raíces o de la pieza, comunicación con el seno maxilar en piezas superiores"],"alternatives":["Tratamiento conservador de la pieza cuando sea posible (endodoncia, restauración)","Control periódico sin intervención"],"consequences":"Persistencia o empeoramiento de la infección, dolor, quistes o daño a las piezas vecinas."}$s$::jsonb, $s$Procedimiento propuesto
Extracción de la pieza dentaria indicada con anestesia local; puede requerir separar la encía, retirar hueso, dividir la pieza y suturar.

Beneficios esperados
• Eliminar el foco de infección y el dolor
• Evitar daño a las piezas vecinas

Riesgos y molestias
• Dolor, inflamación y limitación de la apertura bucal por algunos días
• Sangrado, infección o alveolitis (inflamación del alvéolo)
• Alteración de la sensibilidad del labio o la lengua, generalmente temporal
• Fractura de raíces o de la pieza, comunicación con el seno maxilar en piezas superiores

Alternativas
• Tratamiento conservador de la pieza cuando sea posible (endodoncia, restauración)
• Control periódico sin intervención

Consecuencias de no tratarse
Persistencia o empeoramiento de la infección, dolor, quistes o daño a las piezas vecinas.$s$, ARRAY['exodoncia-']::text[]),
  ('dental', 'endodoncia', $s$Tratamiento de conductos (endodoncia)$s$, $s${"procedure":"Limpieza, conformación y sellado de los conductos radiculares de la pieza indicada, con anestesia local y aislamiento.","benefits":["Conservar la pieza dentaria","Eliminar el dolor y la infección"],"risks":["Molestias o dolor después de la sesión","Fractura de instrumentos dentro del conducto","Persistencia de la infección que requiera retratamiento o cirugía","Debilitamiento de la pieza; puede requerir corona"],"alternatives":["Extracción de la pieza","Control sin tratamiento"],"consequences":"Progresión de la infección, absceso, dolor y pérdida de la pieza."}$s$::jsonb, $s$Procedimiento propuesto
Limpieza, conformación y sellado de los conductos radiculares de la pieza indicada, con anestesia local y aislamiento.

Beneficios esperados
• Conservar la pieza dentaria
• Eliminar el dolor y la infección

Riesgos y molestias
• Molestias o dolor después de la sesión
• Fractura de instrumentos dentro del conducto
• Persistencia de la infección que requiera retratamiento o cirugía
• Debilitamiento de la pieza; puede requerir corona

Alternativas
• Extracción de la pieza
• Control sin tratamiento

Consecuencias de no tratarse
Progresión de la infección, absceso, dolor y pérdida de la pieza.$s$, ARRAY['endodoncia-','retratamiento-de-endodoncia-']::text[]),
  ('dental', 'periodoncia', $s$Tratamiento periodontal$s$, $s${"procedure":"Raspado y alisado radicular para retirar sarro y placa bajo la encía, con anestesia local cuando sea necesario.","benefits":["Controlar la inflamación y el sangrado de encías","Frenar la pérdida de hueso de soporte"],"risks":["Sensibilidad dental temporal","Retracción de la encía y espacios entre dientes","Molestias o sangrado leve después del tratamiento"],"alternatives":["Profilaxis y control de higiene","Cirugía periodontal en casos avanzados"],"consequences":"Avance de la enfermedad periodontal, movilidad y pérdida de piezas."}$s$::jsonb, $s$Procedimiento propuesto
Raspado y alisado radicular para retirar sarro y placa bajo la encía, con anestesia local cuando sea necesario.

Beneficios esperados
• Controlar la inflamación y el sangrado de encías
• Frenar la pérdida de hueso de soporte

Riesgos y molestias
• Sensibilidad dental temporal
• Retracción de la encía y espacios entre dientes
• Molestias o sangrado leve después del tratamiento

Alternativas
• Profilaxis y control de higiene
• Cirugía periodontal en casos avanzados

Consecuencias de no tratarse
Avance de la enfermedad periodontal, movilidad y pérdida de piezas.$s$, ARRAY['raspado-y-alisado-radicular-','curetaje-subgingival','cirugia-periodontal-','colgajo-con-alisado-radicular-']::text[]),
  ('dental', 'implante', $s$Implante dental$s$, $s${"procedure":"Colocación quirúrgica de un implante en el hueso maxilar para reponer una pieza ausente; requiere período de integración antes de la corona.","benefits":["Reponer la pieza ausente con estabilidad","Mejorar la masticación y la estética"],"risks":["Dolor, inflamación y hematoma","Falta de integración o pérdida del implante","Lesión de nervios o del seno maxilar","Necesidad de injerto óseo adicional"],"alternatives":["Puente fijo","Prótesis removible","No reponer la pieza"],"consequences":"Desplazamiento de piezas vecinas, pérdida de hueso y dificultad para masticar."}$s$::jsonb, $s$Procedimiento propuesto
Colocación quirúrgica de un implante en el hueso maxilar para reponer una pieza ausente; requiere período de integración antes de la corona.

Beneficios esperados
• Reponer la pieza ausente con estabilidad
• Mejorar la masticación y la estética

Riesgos y molestias
• Dolor, inflamación y hematoma
• Falta de integración o pérdida del implante
• Lesión de nervios o del seno maxilar
• Necesidad de injerto óseo adicional

Alternativas
• Puente fijo
• Prótesis removible
• No reponer la pieza

Consecuencias de no tratarse
Desplazamiento de piezas vecinas, pérdida de hueso y dificultad para masticar.$s$, ARRAY['colocacion-de-implante-']::text[]),
  ('dental', 'ortodoncia', $s$Tratamiento de ortodoncia$s$, $s${"procedure":"Colocación de aparatos fijos o removibles para mover las piezas dentarias y corregir la mordida durante el tiempo estimado del tratamiento.","benefits":["Mejorar la posición dentaria y la mordida","Facilitar la higiene y la función"],"risks":["Molestias y úlceras durante los ajustes","Desmineralización o caries si la higiene es insuficiente","Reabsorción radicular","Recidiva si no se usan los retenedores"],"alternatives":["Alineadores removibles","No realizar tratamiento"],"consequences":"Persistencia de la maloclusión y sus efectos en la función y la higiene."}$s$::jsonb, $s$Procedimiento propuesto
Colocación de aparatos fijos o removibles para mover las piezas dentarias y corregir la mordida durante el tiempo estimado del tratamiento.

Beneficios esperados
• Mejorar la posición dentaria y la mordida
• Facilitar la higiene y la función

Riesgos y molestias
• Molestias y úlceras durante los ajustes
• Desmineralización o caries si la higiene es insuficiente
• Reabsorción radicular
• Recidiva si no se usan los retenedores

Alternativas
• Alineadores removibles
• No realizar tratamiento

Consecuencias de no tratarse
Persistencia de la maloclusión y sus efectos en la función y la higiene.$s$, ARRAY['ortodoncia-integral-','ortodoncia-limitada-','ortodoncia-interceptiva-','aparatologia-']::text[]),
  ('dental', 'blanqueamiento', $s$Blanqueamiento dental$s$, $s${"procedure":"Aplicación de un agente blanqueador sobre el esmalte en consultorio o con férulas en casa, según indicación.","benefits":["Aclarar el color de los dientes"],"risks":["Sensibilidad dental temporal","Irritación de la encía","Resultado variable; las restauraciones no cambian de color"],"alternatives":["Carillas o restauraciones estéticas","No realizar tratamiento"],"consequences":"El color dental se mantiene; no afecta la salud bucal."}$s$::jsonb, $s$Procedimiento propuesto
Aplicación de un agente blanqueador sobre el esmalte en consultorio o con férulas en casa, según indicación.

Beneficios esperados
• Aclarar el color de los dientes

Riesgos y molestias
• Sensibilidad dental temporal
• Irritación de la encía
• Resultado variable; las restauraciones no cambian de color

Alternativas
• Carillas o restauraciones estéticas
• No realizar tratamiento

Consecuencias de no tratarse
El color dental se mantiene; no afecta la salud bucal.$s$, ARRAY['blanqueamiento-']::text[]),
  ('dental', 'protesis', $s$Prótesis dental$s$, $s${"procedure":"Preparación de piezas, toma de impresiones y adaptación de una prótesis fija o removible para reponer piezas ausentes.","benefits":["Recuperar la masticación y la estética","Evitar el desplazamiento de piezas"],"risks":["Sensibilidad de las piezas preparadas","Período de adaptación con molestias o úlceras","Desajuste o fractura que requiera reparación"],"alternatives":["Implantes","Otro tipo de prótesis","No reponer las piezas"],"consequences":"Dificultad para masticar, desplazamiento de piezas y pérdida de hueso."}$s$::jsonb, $s$Procedimiento propuesto
Preparación de piezas, toma de impresiones y adaptación de una prótesis fija o removible para reponer piezas ausentes.

Beneficios esperados
• Recuperar la masticación y la estética
• Evitar el desplazamiento de piezas

Riesgos y molestias
• Sensibilidad de las piezas preparadas
• Período de adaptación con molestias o úlceras
• Desajuste o fractura que requiera reparación

Alternativas
• Implantes
• Otro tipo de prótesis
• No reponer las piezas

Consecuencias de no tratarse
Dificultad para masticar, desplazamiento de piezas y pérdida de hueso.$s$, ARRAY['corona-de-','corona-metal-','protesis-completa-','protesis-parcial-','puente-']::text[]),
  ('dental', 'odontopediatria', $s$Atención odontopediátrica$s$, $s${"procedure":"Tratamientos preventivos y restauradores en el menor (sellantes, flúor, restauraciones, pulpotomías o extracciones de piezas temporales), con manejo de conducta adaptado a su edad.","benefits":["Tratar la caries y prevenir nuevas lesiones","Conservar el espacio para las piezas permanentes"],"risks":["Molestias durante o después de la atención","Mordedura de labio o mejilla tras la anestesia","Necesidad de repetir el tratamiento si no hay colaboración"],"alternatives":["Atención bajo sedación o anestesia general en centro autorizado","Control y prevención sin tratamiento restaurador"],"consequences":"Dolor, infección y pérdida prematura de piezas temporales.","notes":"Firma el representante legal vigente del menor."}$s$::jsonb, $s$Procedimiento propuesto
Tratamientos preventivos y restauradores en el menor (sellantes, flúor, restauraciones, pulpotomías o extracciones de piezas temporales), con manejo de conducta adaptado a su edad.

Beneficios esperados
• Tratar la caries y prevenir nuevas lesiones
• Conservar el espacio para las piezas permanentes

Riesgos y molestias
• Molestias durante o después de la atención
• Mordedura de labio o mejilla tras la anestesia
• Necesidad de repetir el tratamiento si no hay colaboración

Alternativas
• Atención bajo sedación o anestesia general en centro autorizado
• Control y prevención sin tratamiento restaurador

Consecuencias de no tratarse
Dolor, infección y pérdida prematura de piezas temporales.

Información adicional
Firma el representante legal vigente del menor.$s$, ARRAY[]::text[]),
  ('dental', 'radiografias', $s$Exámenes radiográficos$s$, $s${"procedure":"Toma de radiografías intraorales o extraorales (periapical, interproximal, panorámica o tomografía) con protección radiológica.","benefits":["Diagnosticar lesiones no visibles en el examen clínico","Planificar y controlar el tratamiento"],"risks":["Exposición a dosis bajas de radiación ionizante","Molestia por la colocación de la placa o el sensor"],"alternatives":["Diagnóstico solo con examen clínico, con menor precisión"],"consequences":"Lesiones no detectadas o planificación incompleta del tratamiento.","notes":"Informa si estás o podrías estar embarazada."}$s$::jsonb, $s$Procedimiento propuesto
Toma de radiografías intraorales o extraorales (periapical, interproximal, panorámica o tomografía) con protección radiológica.

Beneficios esperados
• Diagnosticar lesiones no visibles en el examen clínico
• Planificar y controlar el tratamiento

Riesgos y molestias
• Exposición a dosis bajas de radiación ionizante
• Molestia por la colocación de la placa o el sensor

Alternativas
• Diagnóstico solo con examen clínico, con menor precisión

Consecuencias de no tratarse
Lesiones no detectadas o planificación incompleta del tratamiento.

Información adicional
Informa si estás o podrías estar embarazada.$s$, ARRAY[]::text[]),
  ('medical', 'procedimiento-menor', $s$Procedimiento menor en consultorio$s$, $s${"procedure":"Procedimiento menor en el consultorio, con anestesia local: por ejemplo, la sutura de una herida, el drenaje de un absceso o el retiro de una lesión pequeña de la piel.","benefits":["Tratar la lesión en la misma consulta","Evitar que la herida o la infección empeoren"],"risks":["Dolor o molestia en la zona","Sangrado o hematoma","Infección de la herida","Cicatriz visible","Reacción al anestésico local, poco frecuente"],"alternatives":["Tratamiento con medicamentos, cuando es posible","Derivación a un centro con sala de operaciones"],"consequences":"La lesión o la infección pueden empeorar si no se tratan."}$s$::jsonb, $s$Procedimiento propuesto
Procedimiento menor en el consultorio, con anestesia local: por ejemplo, la sutura de una herida, el drenaje de un absceso o el retiro de una lesión pequeña de la piel.

Beneficios esperados
• Tratar la lesión en la misma consulta
• Evitar que la herida o la infección empeoren

Riesgos y molestias
• Dolor o molestia en la zona
• Sangrado o hematoma
• Infección de la herida
• Cicatriz visible
• Reacción al anestésico local, poco frecuente

Alternativas
• Tratamiento con medicamentos, cuando es posible
• Derivación a un centro con sala de operaciones

Consecuencias de no tratarse
La lesión o la infección pueden empeorar si no se tratan.$s$, ARRAY['sutura-simple','drenaje-de-absceso','extraccion-de-una']::text[]),
  ('medical', 'inyectables', $s$Aplicación de medicamentos inyectables$s$, $s${"procedure":"Aplicación de un medicamento por vía intramuscular, subcutánea o endovenosa en el consultorio.","benefits":["Que el medicamento actúe antes o cuando no puede tomarse por boca"],"risks":["Dolor o moretón donde se aplica","Mareo o desmayo","Infección en el sitio de la inyección, poco frecuente","Reacción alérgica, rara vez grave"],"alternatives":["El mismo medicamento por boca, cuando existe y es adecuado"],"consequences":"Sin el medicamento, la enfermedad puede tardar más en mejorar o empeorar."}$s$::jsonb, $s$Procedimiento propuesto
Aplicación de un medicamento por vía intramuscular, subcutánea o endovenosa en el consultorio.

Beneficios esperados
• Que el medicamento actúe antes o cuando no puede tomarse por boca

Riesgos y molestias
• Dolor o moretón donde se aplica
• Mareo o desmayo
• Infección en el sitio de la inyección, poco frecuente
• Reacción alérgica, rara vez grave

Alternativas
• El mismo medicamento por boca, cuando existe y es adecuado

Consecuencias de no tratarse
Sin el medicamento, la enfermedad puede tardar más en mejorar o empeorar.$s$, ARRAY['inyectable-']::text[]),
  ('medical', 'toma-de-muestras', $s$Toma de muestras$s$, $s${"procedure":"Toma de una muestra de sangre, orina o secreción para estudiarla en el laboratorio.","benefits":["Confirmar el diagnóstico","Elegir el tratamiento y seguir cómo responde"],"risks":["Dolor o moretón donde se pincha","Mareo o desmayo","Repetir la toma si la muestra no alcanza"],"alternatives":["Tomar la muestra en un laboratorio"],"consequences":"Sin el examen, el diagnóstico puede quedar incompleto."}$s$::jsonb, $s$Procedimiento propuesto
Toma de una muestra de sangre, orina o secreción para estudiarla en el laboratorio.

Beneficios esperados
• Confirmar el diagnóstico
• Elegir el tratamiento y seguir cómo responde

Riesgos y molestias
• Dolor o moretón donde se pincha
• Mareo o desmayo
• Repetir la toma si la muestra no alcanza

Alternativas
• Tomar la muestra en un laboratorio

Consecuencias de no tratarse
Sin el examen, el diagnóstico puede quedar incompleto.$s$, ARRAY['toma-de-muestra-de-sangre']::text[]);--> statement-breakpoint
INSERT INTO "consent_template" ("organization_id", "key", "title", "body", "sections", "version", "status", "published_at")
SELECT p."organization_id", s.key, s.title, s.body, s.sections, 1, 'publicado', now()
FROM "org_profile" p
JOIN consent_suggestion s ON s.product = p."product"
WHERE NOT EXISTS (SELECT 1 FROM "consent_template" c WHERE c."organization_id" = p."organization_id" AND c."key" = s.key);--> statement-breakpoint
-- Un borrador de lo sugerido que nadie tocó es lo mismo que lo sugerido: queda activo.
UPDATE "consent_template" c SET "status" = 'publicado', "published_at" = now(), "updated_at" = now()
FROM "org_profile" p, consent_suggestion s
WHERE p."organization_id" = c."organization_id" AND s.product = p."product" AND s.key = c."key"
  AND c."status" = 'borrador' AND c."body" = s.body
  AND NOT EXISTS (SELECT 1 FROM "consent_template" o WHERE o."organization_id" = c."organization_id" AND o."key" = c."key" AND o."status" = 'publicado');--> statement-breakpoint
-- Se unen a los servicios de la biblioteca que ya tiene la clínica. Lo que ella ya unió no se toca:
-- ni un consentimiento que ya tiene sus servicios, ni un servicio que ya pide otro consentimiento.
INSERT INTO "consent_template_service" ("organization_id", "template_key", "service_id")
SELECT DISTINCT c."organization_id", c."key", sc."id"
FROM "consent_template" c
JOIN "org_profile" p ON p."organization_id" = c."organization_id"
JOIN consent_suggestion s ON s.key = c."key" AND s.product = p."product"
JOIN "service_catalog" sc ON sc."organization_id" = c."organization_id" AND sc."is_active"
JOIN "catalog"."treatment_template" t ON t."id" = sc."template_id"
JOIN LATERAL unnest(s.prefixes) AS prefix ON t."key" LIKE prefix || '%'
WHERE c."status" = 'publicado' AND c."reviewed_at" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "consent_template_service" l WHERE l."organization_id" = c."organization_id" AND l."template_key" = c."key")
  AND NOT EXISTS (SELECT 1 FROM "consent_template_service" l WHERE l."organization_id" = sc."organization_id" AND l."service_id" = sc."id")
ON CONFLICT DO NOTHING;
