# 0208 · «No se hizo» en lo firmado, la consulta al firmar y «Sin enfermedad»

Fecha: 2026-11-19 · **Estado:** aceptada (mesa del cierre de la atención; lienzo KC8UB5TpuuVwCDHGxvBBda)

## Problema

Tres huecos del cierre de la atención, vistos en una presentación y por el usuario:

- **El diagnóstico obligatorio no dejaba registrar un chequeo de alguien sano.** Para firmar había que buscar un código o inventar una enfermedad.
- **Una consulta sin nada hecho se firmaba con «No se carga nada».** La evaluación de la cita no la cobraba nadie, aunque casi todas las clínicas la cobran.
- **Lo firmado por error solo admitía una adenda de texto.** El plan, el odontograma, el inventario y el cobro seguían diciendo que se hizo, y caja quitó el cobro equivocado porque dos cargos se llamaban igual.

Restricciones: lo clínico lo decide el profesional; el diagnóstico sigue siendo necesario para firmar (17 nov); el dinero lo mueve caja; lo firmado no se reescribe.

## Decisión y motivo

- **«Sin enfermedad».** Son atajos con los códigos del capítulo de los factores que motivan la consulta: CIE-10 Z00–Z99 y CIE-11 QA–QB (`@odentia/clinical` `without-disease.ts`, por producto en `ProductHooks.withoutDisease`).
  - odentIA ofrece siempre «Chequeo» (Z01.2) y «Sin hallazgos» (Z71.1). Ofrece el control, la prótesis y la ortodoncia solo si le corresponden.
  - latidIA elige el examen del adulto o del niño por la edad.
  - Se registran definitivos y quedan resueltos.
  - No salen si algo de hoy propone un diagnóstico, ni si la persona tiene uno activo: entonces se propone ese, «Sigue activo».
- **La consulta al firmar.** Ningún dato dice cuál es «la consulta de la clínica», así que se elige en este orden: el servicio de la cita si es una consulta; si no, la que más cobra la clínica en 6 meses; si no, la de su biblioteca.
  - Viene marcada solo si hoy no se registró nada hecho, no se cobró ya y la visita no venía a una sesión.
  - En odentIA tampoco viene si la visita es el control de un tratamiento. En latidIA, que cobra el control, viene su consulta de control.
  - Se registra como un acto más: se carga y da comisión. Desmarcarla queda en la actividad.
- **El cierre nombra lo que se firma.** Cada acto va con su pieza y lo que se cargará, con la misma regla de la firma: `chargeDecisionsOf` decide sin escribir, y la firma crea los cargos.
- **«No se hizo».** Quien firmó, el dueño o quien administra marca el procedimiento de una atención firmada como anulado, con motivo y una adenda.
  - **Lo clínico vuelve atrás:**
    - el plan (lo directo queda por decidir o se quita; una sesión que no fue la última no cambia nada);
    - el odontograma;
    - el diagnóstico resuelto por esa firma;
    - los materiales.
  - **El dinero:**
    - lo que nadie pagó se anula;
    - lo pagado no se toca, y caja recibe una tarea;
    - Finanzas, Reportes y `commission_live` cuentan por el cargo, no por si el acto se anuló;
    - lo devuelto de un acto «No se hizo» no cuenta como cobrado, así que el tratamiento se vuelve a cobrar al hacerse.
- **Los cargos de un acto llevan su pieza.**

## Alternativas descartadas

- **Quitar el diagnóstico obligatorio, o firmar sin él con un motivo.** Pierde el código de la consulta, y el atajo cuesta menos que escribir un motivo.
- **Que la clínica elija «su consulta» en la configuración.** Es otra pantalla y otro dato para algo que la cita y lo cobrado ya dicen.
- **Que «No se hizo» anule también lo pagado.** Reportes y Comisiones cambiaban meses atrás aunque la caja tuviera el dinero, y un cargo pagado a medias no tiene cómo anularse.
- **Marcarlo con una columna aparte en vez de anular el procedimiento.** Cada lectura clínica (sesiones, plan, odontograma) tendría que aprenderla. Anular ya significa «no cuenta» en todas.

## Consecuencias

- **Beneficios:**
  - el chequeo se firma con un toque;
  - la consulta se cobra sin acordarse de agregarla;
  - un error firmado se corrige sin tocar la plata ajena;
  - caja distingue cada cargo por su pieza.
- **Sacrificios:**
  - el guardia de la base deja anular un procedimiento de una firmada (solo su anulación, una vez);
  - con la comisión repartida por sesiones, anular una sesión corre las partes a la siguiente;
  - la hoja de atención y el odontograma ya firmados no se rehacen: llevan la adenda.
- **Revisar si:**
  - una clínica real cobra la consulta de otra forma;
  - la norma pide corregir de otra manera un odontograma firmado.

## Referencias

`packages/services/src/encounter-not-done.ts`, `closing-consultation.ts`, `encounters.ts` (`chargeDecisionsOf`, `checkEncounterClosing`, `finalizeEncounter`), `diagnosis-codes.ts`, `charge-returns.ts`, migración `0151_lo_que_no_se_hizo.sql`.
