# 0115 · Los documentos del paciente: un solo kit, firma al emitir, QR y explicación por servicio

Fecha: 2026-10-30. Estado: aceptada.

## Problema

Receta, orden, descanso, consentimiento, presupuesto, ticket, devolución, historia y registro de actividades salían de dos escritores de PDF con encabezados copiados. El PDF de la receta difería de su hoja en pantalla, el presupuesto no decía qué se haría ni por qué, «Cómo se paga» estaba escrito en el código y quien tenía un papel en la mano no podía saber si seguía vigente. En odentIA y en latidIA.

## Decisión y motivo

- **Un kit** (`services/src/document-kit.ts`): Noto Sans y Noto Serif embebidas, hoja A4 o Carta del perfil, rollo térmico recortado, encabezado corto, «Página X de Y», tablas, firmas y QR vectorial. El papel es de la clínica: sin el color de la plataforma; color solo en ANULADO y REVOCADO. Un carácter sin glifo sale como `?`: un emoji no traba el trabajo. La clínica en el papel tiene un solo tipo y una sola función (`DocumentClinic`, `document-clinic.ts`); un ticket conserva lo congelado.
- **Firma electrónica simple al emitir**: no hay paso nuevo. El papel dice «Firmado electrónicamente» con los datos congelados del perfil profesional y la hora de emisión, sin línea de firma a mano del profesional. No se presenta como firma digital certificada.
- **Comprobar con QR, sin cuenta**: token HMAC sin tabla (clínica, tipo e id) y `GET /api/public/documents/:token`. Responde el estado y lo mínimo para cotejar el papel; nunca diagnóstico, medicamentos, título de la orden o del consentimiento, motivo de anulación ni nombre completo. Un token inválido es el mismo 404 que un documento que no está.
- **Explicación por servicio** (`PatientGuide`): biblioteca → servicio → ajuste del presupuesto → copia al entregar. La biblioteca solo sugiere: nada le llega a un paciente hasta que la clínica lo guarda, y sin explicación el servicio sale solo con nombre y precio. Lo entregado no cambia: lo protege también la base.
- **Lo clínico del presupuesto** (`findings`, diagnósticos y alergias) sale solo a quien tiene `clinical.read` o en el papel para la propia persona o su representante. `findings` no viaja en `getBudgetDetail`, así que no llega al agente ni a lo público por esa vía.
- **Sin Clío en esta entrega**: `findings` lo escribe el profesional; por defecto sale el nombre del diagnóstico.
- **Un papel no crea enlaces**: el QR de «Su enlace» en el presupuesto sale solo si quien decide ya tiene uno vivo. Generarlo renueva o revoca enlaces, un efecto que un GET de impresión no debe tener; enviar el presupuesto sí lo emite, y lo hace antes de armar la hoja. Ajusta [0037](0037-su-enlace-y-portal-en-un-paso.md): el QR lleva el enlace en el PDF guardado, y quien ve ese PDF lo tiene, como quien hoy usa «Copiar enlace» o «Mostrar su código». El equipo no gana un acceso nuevo; a cambio, la persona responde sin imprimir.

## Alternativas descartadas

- Imprimir desde HTML con un navegador sin cabeza: mismo diseño que las pantallas, pero un proceso pesado y otra dependencia en el servidor y el worker para cada envío.
- Tabla de tokens de comprobación: permitiría revocar un token, pero el estado ya lo da el documento y agrega una fila por papel sin valor.
- Texto sugerido visible hasta que la clínica lo cambie: más rápido de arrancar, pero le atribuiría a la clínica un texto clínico que nunca revisó.

## Consecuencias

Una sola pieza que cuidar; los PDF de consentimiento ya guardados con su huella no se tocan. El QR denso exige un token corto y un papel en buen estado. Las hojas HTML dejan de ser fuente. Vencer un presupuesto solo se imprime y se muestra: revisar si la clínica pide que impida aceptar. Lo jurídico de la firma simple queda por validar antes de presentarla como cumplimiento en cada país.

## Referencias

`packages/services/src/document-kit.ts`, `document-check.ts`, `budget-pdf.ts`, `clinical-papers.ts`; `packages/db/drizzle/0025_documentos_formales.sql`.
