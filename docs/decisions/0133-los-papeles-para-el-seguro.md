# 0133 · Los papeles para el seguro

Fecha: 2026-11-02 · Estado: aceptada · Ajusta [0131](0131-la-firma-que-se-ve-en-el-papel.md)

## Problema

Para reembolsar, las aseguradoras piden documentos con datos concretos, también en sus canales digitales: Rímac por su app, Pacífico por Mi Espacio. Sus guías piden firma, sello con colegiatura, diagnóstico y fecha; la de Rímac admite en lo digital una hoja de atención en lugar de su solicitud, y la de Pacífico la pide por tipo de atención. Lo digital cambia el canal, no el contenido: la revisión parece hecha a ojo, porque ninguna guía menciona un QR, un certificado ni la firma electrónica. El dueño del producto pidió hacer lo posible por cumplirles.

Teníamos firma dibujada, nombre y colegiatura, pero nada que un revisor reconociera como sello, y ningún papel equivalente a una hoja de atención. El médico tenía que imprimir, sellar y fotografiar, o redactar la hoja aparte.

## Decisión y motivo

- **Todo papel firmado lleva un sello:** un recuadro con nombre, título y colegiatura, generado de la copia de quien firma. Sale solo, no pide subir nada. Sigue diciendo «Firmado electrónicamente» para que nadie crea que se selló a mano.
- **La hoja de atención sale de la atención firmada,** como un papel más: se ve, se envía, se imprime y queda fija con su QR (ADR 0132). Lleva lo que piden: paciente, fecha, diagnósticos, procedimientos con pieza y caras, exámenes pedidos, tratamiento sugerido e indicaciones.
- **No lleva evolución, examen físico, antecedentes ni motivo de consulta.** El papel sale de la clínica y nadie los pide. Si una aseguradora pide más, envía su pedido y la clínica decide.
- **No lleva costos.** El costo por procedimiento lo piden en el comprobante electrónico; el precio registrado en la atención puede no ser lo que se cobró, y un importe distinto en un papel firmado haría más daño que su ausencia.
- **La receta avisa qué miran los seguros,** en el formulario: el diagnóstico y la cantidad siguen siendo opcionales, porque el sistema no traba el trabajo diario.
- **La hoja del odontograma dice cómo llevarla:** a color y guardada como PDF desde «Imprimir», porque Pacífico lo pide en rojo y azul.

## Alternativas descartadas

- *Pedir una foto del sello real.* Obliga a recortarla y limpiarla, y por sí sola no prueba más que el recuadro.
- *Construir el formulario de cada aseguradora.* Son formatos ajenos que cambian, y en lo digital la hoja de atención puede reemplazarlos.
- *Exigir diagnóstico y cantidad en toda receta.* Trabaría recetas que nunca irán a un seguro.
- *Emitir boleta o factura electrónica.* Es lo que más piden, pero es un proyecto aparte con SUNAT; no se resuelve aquí.
- *Conectar con SITEDS y TEDEF.* Es el camino de la clínica con convenio, no el del reembolso, y ninguna clínica lo ha pedido.

## Consecuencias

- **No sabemos si las aseguradoras aceptan el sello impreso ni la firma electrónica:** ninguna guía lo dice, y falta probarlo con un reembolso real. Mientras tanto, imprimir y sellar a mano sigue siendo el camino seguro, y el papel lo permite.
- El sello es una imagen: se puede copiar y no prueba quién firmó, igual que la firma dibujada. La Directiva 343 pide firma digital para lo clínico, así que esto mejora la presentación, no el nivel legal.
- Una clínica sigue emitiendo su comprobante electrónico aparte, y el ticket de caja no lo reemplaza. Tampoco queda resuelto el periodontograma que Pacífico pide en planes EPS: no se puede imprimir hoy. Tampoco el costo por pieza que pide Sanitas en su odontograma.
- Se revisa si alguna aseguradora rechaza el sello, o si varias clínicas piden el comprobante electrónico o el periodontograma.

## Referencias

`packages/services/src/attention-sheet.ts`, `clinical-papers.ts` (`renderAttentionSheetPdf`), `document-kit.ts` (`signedBlock`), `packages/clinic-app/src/components/patient/document-papers.tsx` (`AttentionSheetPaper`), `e2e/documento-emitido.spec.ts`. Guías leídas el 2026-11-02: Rímac, manual de reembolso; Pacífico, documentos por tipo de atención (enero de 2024); Sanitas, solicitud de reembolso odontológico.
