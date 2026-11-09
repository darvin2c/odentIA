# 0167 · El examen de la vista y la receta de lentes

Fecha: 2026-11-08 · Estado: aceptada · Sigue a [0166](0166-vistia-el-producto-de-las-opticas.md). Entrega 3 del plan «vistIA: plan para ópticas».

## Problema

Una óptica examina la vista y entrega una receta: la de anteojos y, aparte, la de lentes de contacto. De esa receta sale la venta de los lentes. Muchas veces el cliente trae la receta de su oftalmólogo. Hasta ahora vistIA solo tenía la nota libre de la atención y la receta de medicamentos.

## Decisión y motivo

- **El examen de la vista es el examen de la atención en vistIA** (`encounter.examination`, como el examen físico de latidIA): quién acompaña a un menor, antecedentes de la vista, agudeza visual por ojo sin y con corrección de lejos y de cerca (Snellen, decimal o CD/MM/PL/NPL), refracción por ojo (esfera y cilindro en pasos de 0,25 D, eje de 1 a 180 solo con cilindro, adición, prisma con su base), distancia pupilar monocular y salud del ojo (externo, pupilas, fondo de ojo o constancia de que no se hizo, presión si hay equipo). Lo valida `@odentia/optical` y cada error vuelve junto a su dato. Sin signos vitales: una óptica no los toma.
- **Lo que conviene que vea un oftalmólogo se informa, no frena:** presión alta del ojo, fondo de ojo o pupilas con hallazgos, una vista que no llega a 20/40 con corrección o que solo cuenta dedos o ve luz. El optómetra decide si deriva con la orden de interconsulta que ya existe.
- **La receta de lentes es su propia tabla, `optical.lens_prescription`**, en el esquema de vistIA (ADR 0079) y con la RLS de la clínica. De anteojos o de lentes de contacto (con curva base, diámetro y marca). La de la óptica sale de la refracción del examen, una de cada tipo por atención, y la firma quien atiende con su colegiatura. La externa se transcribe con quién la firmó y su fecha, y queda «sin verificar» hasta que un optómetra la revise. Emitida no cambia: la aplicación solo puede verificarla o anularla, con su motivo (permisos por columna en la base). Vale un año si no se dice otra cosa; vencida o sin verificar se avisa y no impide vender.
- **Se imprime y el cliente la ve:** un PDF con el membrete de la óptica, y en «Tus documentos» del portal por un gancho del producto (`portalPapers`), sin que lo común conozca la tabla.
- **La copia de la historia** lleva el examen y las recetas; las demos traen exámenes coherentes con la medida de cada persona y la receta de cada uno.

## Alternativas descartadas

- **Usar la receta de medicamentos para los lentes.** Sus datos (DCI, dosis, vía) no son los de un lente, y mezclarlos confundiría a quien vende.
- **Guardar la receta solo dentro del examen.** La externa no tiene atención, y la vigente se busca entre todas: la venta (entrega 4) la necesita sin abrir la historia.
- **Dictar el examen a Clío.** Sigue fuera (ADR 0166).

## Consecuencias

- La venta de lentes (entrega 4) toma la receta vigente; el rol Ventas la verá sin ver el resto de la historia.
- Cuánto dura una receta (de adulto, de niño, de lentes de contacto) y la notación de cada óptica se confirman con la primera óptica real.

## Referencias

`packages/optical/src/eye-exam.ts` y `lens-prescription.ts`, `packages/db/drizzle/0070_receta_de_lentes.sql`, `packages/services/src/optical/` (examen, recetas, PDF), `apps/api/src/routes/optical/lens-prescriptions.ts`, `apps/optical-clinic/src/product/optical/`.
