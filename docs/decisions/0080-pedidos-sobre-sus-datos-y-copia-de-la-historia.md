# 0080 · Pedidos sobre sus datos y copia de la historia

- **Fecha:** 2026-10-22
- **Estado:** aceptada (fase 1: copia, corregir y no recibir mensajes; la fase 2 suma borrar y bloquear)

## Problema

La persona tiene derecho a pedir una copia de sus datos, que se corrijan o que no le escriban (acceso, rectificación y oposición en la ley de cada país: ARCO en Perú y México, RGPD, LGPD). La clínica no tenía dónde registrarlo, cómo entregar la historia entera ni cómo demostrar que respondió a tiempo, y el encargo prometía «exportar» sin que existiera (issues 45 y 50). Cada país pone plazos distintos, y odentIA no quiere configuraciones que la clínica no necesita.

## Decisión y motivo

- **Un solo plazo, en cualquier país:** 10 días corridos desde el día siguiente al pedido. Es más corto que lo que piden las leyes de la región (Perú 10 a 20 días hábiles, Colombia 10 a 15 hábiles, México 20 hábiles, Brasil 15), así que respondiendo a tiempo se cumple en todas, sin plazos, feriados ni datos por país.
- **Pendiente → respondida o denegada (con motivo).** Comprobar que es ella o su representante legal es un paso dentro de «pendiente», nunca por el número de teléfono. Lo pide solo quien decide por el paciente (`listDecisionRecipients`).
- **«No recibir mensajes» se cumple al registrarlo:** se apagan recordatorios, controles y novedades; los avisos de sus citas y papeles siguen.
- **La copia es un PDF para leer y un paquete HL7 FHIR R4** (`Bundle` de tipo `collection`) para que otra clínica lo cargue. Los códigos propios no se renombran: se traducen con la tabla de equivalencias de `@odentia/clinical` (`fhir.ts`), probada contra los value sets de R4. Lo que no tiene equivalencia segura va como texto.
- **Quién:** Recepción y Administración registran, comprueban, envían y responden (`patients.write`). Recepción nunca ve lo clínico: «Enviar» arma el PDF en el servidor y se lo manda a la persona sin mostrarlo. Descargar el ZIP (PDF, FHIR e imágenes con los cortes de cada tomografía) es de quien lee la ficha clínica (`clinical.read`) y queda en «Consultas a la historia» y en la auditoría.
- **Inicio › Te espera** muestra el pedido desde 3 días antes de su plazo y siempre que venció.

## Alternativas descartadas

- **Plazos y días hábiles por país en el perfil:** cumple igual, pero suma datos que mantener, un calendario de feriados por país y riesgo de error, sin valor para la clínica.
- **Cinco estados (recibida, verificada, en curso…):** más decisiones para Recepción sin información nueva.
- **Que Recepción descargue la historia:** rompe la regla de que lo clínico no llega a Recepción.
- **Enviar el ZIP o el FHIR por WhatsApp:** WhatsApp no acepta esos archivos; se envía el PDF y el ZIP se descarga.

## Consecuencias

- En Perú la copia se responde en 10 días aunque la ley permita 20.
- El FHIR no pasa todavía por el validador oficial de HL7; las pruebas validan las equivalencias y la forma del paquete.
- Borrar y bloquear la historia (fase 2) y el borrado automático al vencer la conservación quedan fuera; cuando lleguen, la conservación por país se suma al perfil del país.
- Revisar si una ley de un país donde vendamos pide menos de 10 días.

## Referencias

- `packages/services/src/data-requests.ts`, `patient-record.ts`; `packages/clinical/src/fhir.ts`.
- `apps/api/src/routes/patient-data-requests.ts`; migraciones `0074` y `0075`.
- Lienzo «Datos del paciente: copia, corrección y borrado» (aprobado el 2026-10-22).
