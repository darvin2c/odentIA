# 0071 · Metas del mes, «Descargar» y el resumen del lunes

Fecha: 2026-10-20 · Estado: aceptada · Lienzo «Reportes odentIA · cómo va el negocio», aprobado entero el 2026-10-18 (decisiones 9, 10, 11 y 15; fase 6).

## Problema

Reportes dice cómo va la clínica, pero no contra qué. Lo que muestra no se podía llevar a una hoja de cálculo. Y para enterarse había que entrar. Las tres cosas tenían que salir de las mismas cifras de la pantalla, sin otra cuenta.

## Decisión y motivo

- **Dos metas por mes, de toda la clínica:** cobrado y pacientes nuevos (`report_goal`).
  - Una meta vale desde el mes en que se guarda hasta que otra la reemplace. Cambiarla no reescribe los meses pasados, y quitarla es otra fila sin importe.
  - Lo cobrado va en la moneda de la clínica y nunca se compara con otra.
  - Solo hay meta con un mes elegido y con «Todas las sedes»: un rango de días o varios meses no tienen meta (decisión 15).
  - El avance lo calcula el servidor dentro del Resumen. En el mes en curso dice cuánto del mes ya pasó y cuántos días quedan. Solo se pone en el mes en curso.
- **«Descargar» en CSV (RFC 4180)** en cada lista y en cada tabla (Por profesional, Comisiones, una respuesta de Argos).
  - El archivo lleva la marca UTF-8 para que Excel lea los acentos, filas en CRLF y los importes sin miles y con punto.
  - El servidor lo arma con la misma consulta y la lista entera, hasta 5 000 filas.
  - El teléfono va solo si quien descarga puede ver los datos de la persona.
- **El resumen del lunes:**
  - Cada persona con Reportes lo prende para sí (`report_digest`); nace apagado.
  - Sale el lunes desde las 8:00, en la zona de la clínica, con la semana anterior: cuatro cifras, lo que cambió y la primera recomendación de Argos, con frases fijas y sin modelo.
  - Antes de enviarlo se reserva la semana (`report_digest_send`). Un envío incierto no se repite.
  - No sale si no hubo movimientos o si la persona ya no ve Reportes. Una clínica en pausa comercial no lo recibe.
  - Para dejar de recibirlo basta el enlace del correo, con la clínica y la persona firmadas con la clave del servidor, sin entrar.

## Alternativas descartadas

- **Metas por sede o por profesional, o que cambiar la meta valga para los meses pasados:** suman decisiones sin uso probado, y lo segundo reescribiría lo que ya se vio.
- **Armar el CSV en el navegador con lo que hay en pantalla:** las listas traen 200 filas, y el archivo diría menos que la cifra.
- **Que un modelo redacte el resumen:** podría contradecir a la pantalla y cobraría por cada correo.
- **Prenderlo para todos por defecto:** a nadie le debe llegar un correo que no pidió.
- **Baja con un toque (`List-Unsubscribe`):** el worker no conoce la dirección de la API. El enlace del pie basta mientras no haga falta.

## Consecuencias

- Lo que el correo dice sale del catálogo de cifras (0070): una cifra nueva del resumen se agrega ahí.
- El correo usa el molde común (issue 163), con bloques después de la ficha y el enlace de baja junto al motivo.
- Revisar si las clínicas piden metas por sede, o si el resumen debe poder elegir sus cifras.

## Referencias

`packages/services/src/report-goals.ts`, `report-csv.ts`, `report-digest.ts`, `apps/worker/src/report-digests.ts`, `apps/api/src/routes/report-digest-public.ts`, `apps/dental-clinic/src/components/reports/summary-extras.tsx`, `apps/dental-clinic/src/routes/resumen-lunes.baja.$token.tsx`.
