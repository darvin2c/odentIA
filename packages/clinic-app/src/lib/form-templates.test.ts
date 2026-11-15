import { expect, it } from "vitest"
import type { FormSectionDef, FormTemplate } from "./clinical-forms"
import {
  currentLine,
  leaveWords,
  newField,
  nextAfter,
  oneAtATime,
  publishWords,
  reuseWords,
  requiredWithoutNone,
  rowButtonAfter,
  sameTitleTemplate,
  settleFieldKeys,
  templateGroups,
  templateOptionLabel,
  twinDetail,
  versionStatusWords,
} from "./form-templates"

let n = 0
function template(patch: Partial<FormTemplate> & Pick<FormTemplate, "key" | "title">): FormTemplate {
  n += 1
  return {
    id: `t-${n}`,
    organizationId: "org",
    specialtyId: null,
    description: null,
    version: 1,
    status: "publicado",
    schema: { sections: [] },
    respondent: "staff",
    publishedAt: "2026-11-01T15:00:00.000Z",
    createdAt: "2026-11-01T15:00:00.000Z",
    updatedAt: "2026-11-01T15:00:00.000Z",
    reachesPatients: false,
    ...patch,
  }
}

it("lo que se dejó de usar sale de la lista y queda en «Ya no se usan», con la fecha en que se dejó", () => {
  const endodoncia = template({ key: "endodoncia", title: "Evaluación de endodoncia" })
  const periodontal = template({
    key: "periodontal",
    title: "Ficha periodontal",
    status: "archivado",
    updatedAt: "2026-11-13T20:40:00.000Z",
  })
  // Se publicó la 2 y luego se dejó de usar: la que vuelve es la 2, no la 1.
  const ortodonciaV1 = template({ key: "ortodoncia", title: "Ficha de ortodoncia", status: "archivado" })
  const ortodonciaV2 = template({
    key: "ortodoncia",
    title: "Ficha de ortodoncia inicial",
    version: 2,
    status: "archivado",
    updatedAt: "2026-11-12T10:00:00.000Z",
  })
  // Un borrador que se archivó sin publicarse nunca se usó.
  const nunca = template({ key: "nunca", title: "Nunca publicado", status: "archivado", publishedAt: null })
  // Sin vigente pero con un borrador: sigue en la lista, se vuelve a usar publicándolo.
  const conBorrador = [
    template({ key: "pediatria", title: "Odontopediatría", status: "archivado" }),
    template({ key: "pediatria", title: "Odontopediatría", version: 2, status: "borrador", publishedAt: null }),
  ]
  const groups = templateGroups([endodoncia, periodontal, ortodonciaV1, ortodonciaV2, nunca, ...conBorrador])
  expect(groups.listed.map((versions) => versions[0]?.key)).toEqual(["endodoncia", "nunca", "pediatria"])
  expect(groups.unused).toEqual([
    { last: ortodonciaV2, leftAt: "2026-11-12T10:00:00.000Z" },
    { last: periodontal, leftAt: "2026-11-13T20:40:00.000Z" },
  ])
})

it("de dos cuestionarios del paciente publicados, solo el que le llega dice «vigente»", () => {
  const previo = template({ key: "previo", title: "Cuestionario previo a la cita", respondent: "portal" })
  const salud = template({ key: "salud", title: "Cuestionario de salud", respondent: "portal", reachesPatients: true })
  const all = [previo, salud]
  expect(versionStatusWords(salud)).toBe("vigente")
  expect(versionStatusWords(previo)).toBe("no llega a los pacientes")
  expect(currentLine([salud], all)).toBe("Vigente: versión 1 · es el que reciben los pacientes con cita por venir")
  expect(currentLine([previo], all)).toBe(
    "Versión 1 publicada, pero no les llega: los pacientes reciben «Cuestionario de salud»",
  )
  // Uno del equipo no cambia sus palabras.
  const ficha = template({ key: "ficha", title: "Ficha" })
  expect(versionStatusWords(ficha)).toBe("vigente")
  expect(currentLine([ficha], [...all, ficha])).toBe("Vigente: versión 1")
})

// Mesa de formularios del 13 nov, entrega 8: lo que respondía el paciente ya no se publica ni vuelve,
// y ninguna confirmación dice «lo reciben los pacientes» ni «en lugar de».
it("un cuestionario que respondía el paciente ya no se publica ni vuelve: la confirmación dice dónde está ahora", () => {
  const previo = template({ key: "previo", title: "Cuestionario previo a la cita", respondent: "portal", status: "archivado" })
  const borrador = template({ key: "dos", title: "Cuestionario dos", respondent: "portal", status: "borrador", publishedAt: null })
  for (const words of [publishWords(borrador, [previo, borrador]), reuseWords(previo) ?? "", leaveWords(previo)]) {
    expect(words).toContain("Lo respondía el paciente y ya no se usa")
    expect(words).toContain("Configuración › Preguntas al paciente")
    expect(words).not.toContain("lo reciben los pacientes")
    expect(words).not.toContain("en lugar de")
  }
})

it("publicar una ficha dice qué pasa con la versión anterior, y la primera queda en uso", () => {
  const ficha = template({ key: "ficha", title: "Ficha de ingreso", status: "borrador", publishedAt: null })
  expect(publishWords(ficha, [ficha])).toBe(
    "Quedará en uso: se llena en la atención y en «Nuevo» › «Ficha». Una versión publicada ya no se edita: para cambiarla se prepara la siguiente.",
  )
  const v1 = template({ key: "ficha", title: "Ficha de ingreso" })
  const v2 = template({ key: "ficha", title: "Ficha de ingreso", version: 2, status: "borrador", publishedAt: null })
  expect(publishWords(v2, [v1, v2])).toBe(
    "La versión 1 se archiva y las fichas nuevas usarán la 2. Lo ya respondido conserva su título y sus preguntas.",
  )
})

it("dejar de usar dice qué deja de pasar y que lo ya llenado no cambia", () => {
  const ficha = template({ key: "periodontal", title: "Ficha periodontal" })
  const staff = leaveWords(ficha)
  // QA del 14 nov: decía «Deja de ofrecerse… volver a usarlo» y no que deja de aparecer sola en la atención.
  expect(staff).toContain("Deja de aparecer sola en la atención")
  expect(staff).toContain("Lo ya llenado sigue en cada paciente")
  expect(staff).toContain("volver a usarla, enciende su interruptor «En uso»")
  expect(staff).not.toContain("usarlo")
})

it("volver a usar uno del equipo no pregunta", () => {
  expect(reuseWords(template({ key: "periodontal", title: "Ficha periodontal", status: "archivado" }))).toBeNull()
})

it("un título que ya tiene otro formulario se avisa, también si está en «Ya no se usan»", () => {
  const endodoncia = template({ key: "endodoncia", title: "Evaluación de endodoncia" })
  const periodontal = template({ key: "periodontal", title: "Ficha periodontal", status: "archivado" })
  const all = [endodoncia, periodontal]
  expect(sameTitleTemplate("Otra ficha", all)).toBeNull()
  expect(sameTitleTemplate("", all)).toBeNull()
  // Sin tildes, mayúsculas ni espacios de más: es el mismo título.
  // El que está en uso se ofrece para abrirlo y cambiarlo, en vez de crear otro.
  expect(sameTitleTemplate("  evaluacion de   ENDODONCIA ", all)).toEqual({
    title: "Evaluación de endodoncia",
    unused: null,
    existing: endodoncia,
  })
  // Si ese ya tiene un borrador preparado, lo que se abre es el borrador.
  const draft = template({ key: "endodoncia", title: "Evaluación de endodoncia", version: 2, status: "borrador", publishedAt: null })
  expect(sameTitleTemplate("Evaluación de endodoncia", [...all, draft])?.existing).toBe(draft)
  // El que se dejó de usar se ofrece para volver a usarlo.
  expect(sameTitleTemplate("Ficha periodontal", all)).toEqual({
    title: "Ficha periodontal",
    unused: { last: periodontal, leftAt: periodontal.updatedAt },
    existing: null,
  })
  // La plantilla que se está editando no es su propio doble.
  expect(sameTitleTemplate("Evaluación de endodoncia", all, "endodoncia")).toBeNull()
})

it("una pregunta nueva nace vacía, y su clave sale del texto completo al guardar", () => {
  const first = newField([])
  expect(first).toEqual({ id: "campo_1", label: "", type: "texto" })
  const second = newField([first])
  expect(second.id).toBe("campo_2")
  const sections: FormSectionDef[] = [
    {
      id: "general",
      title: "General",
      fields: [
        { id: "tiene_dolor", label: "¿Tiene dolor?", type: "booleano" },
        // Agregadas en esta sesión: la clave provisional no depende de lo primero que se tecleó.
        { ...first, label: "¿Desde cuándo tiene la molestia?" },
        { ...second, label: "¿Tiene dolor?", type: "booleano" },
        { id: "campo_3", label: "Detalle", type: "texto", showIf: { field: "campo_2", equals: true } },
      ],
    },
  ]
  const settled = settleFieldKeys(sections, new Set([first.id, second.id, "campo_3"]))
  expect(settled[0]?.fields.map((field) => field.id)).toEqual([
    "tiene_dolor",
    "desde_cuando_tiene_la_molestia",
    // No repite la clave de una pregunta que ya estaba.
    "tiene_dolor_2",
    "detalle",
  ])
  // La condición sigue a la pregunta de la que dependía.
  expect(settled[0]?.fields[3]?.showIf).toEqual({ field: "tiene_dolor_2", equals: true })
  // Lo que ya estaba guardado conserva su clave, aunque parezca provisional.
  const saved: FormSectionDef[] = [{ id: "s", title: "S", fields: [{ id: "campo_1", label: "Motivo de consulta", type: "texto" }] }]
  expect(settleFieldKeys(saved, new Set())).toBe(saved)
})

it("dos formularios con el mismo título se distinguen por cuántas preguntas tienen y cuándo se crearon", () => {
  const when = (iso: string) => iso.slice(0, 16).replace("T", " ")
  const fields = (n: number) => ({
    sections: [{ id: "s", title: "S", fields: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, label: `P${i}`, type: "texto" as const })) }],
  })
  const a = template({ key: "orto", title: "Ficha de ortodoncia inicial A", schema: fields(4), createdAt: "2026-11-13T21:43:00.000Z" })
  const b = template({ key: "orto-2", title: "ficha de ortodoncia  inicial a", schema: fields(1), createdAt: "2026-11-13T21:47:00.000Z" })
  const other = template({ key: "endo", title: "Evaluación de endodoncia", schema: fields(5) })
  const all = [a, b, other]
  expect(twinDetail(a, all, when)).toBe("4 preguntas · creado el 2026-11-13 21:43")
  expect(twinDetail(b, all, when)).toBe("1 pregunta · creado el 2026-11-13 21:47")
  // El que no se repite no lleva nada de más.
  expect(twinDetail(other, all, when)).toBeNull()
  // Las versiones de un mismo formulario no son dos formularios.
  const aV2 = template({ key: "orto", title: "Ficha de ortodoncia inicial A", version: 2, schema: fields(5) })
  expect(twinDetail(a, [a, aV2, other], when)).toBeNull()
  // En el desplegable de «Nuevo» › «Formulario», el detalle va junto al título.
  expect(templateOptionLabel(a, all, when)).toBe("Ficha de ortodoncia inicial A · 4 preguntas · creado el 2026-11-13 21:43")
  expect(templateOptionLabel(other, all, when)).toBe("Evaluación de endodoncia")
  // Al volver a usarlo nace otra versión, con otra fecha: lo que se dice es cuándo se creó el
  // formulario (su primera versión, lo dice el servidor), para que esa línea no cambie.
  const aBack = template({
    key: "orto",
    title: "Ficha de ortodoncia inicial A",
    version: 2,
    schema: fields(4),
    createdAt: "2026-11-13T23:06:00.000Z",
    formCreatedAt: "2026-11-13T21:43:00.000Z",
  })
  expect(twinDetail(aBack, [aBack, b, other], when)).toBe("4 preguntas · creado el 2026-11-13 21:43")
})

it("un clic a la vez: el segundo clic de un doble clic no se envía", () => {
  const guard = oneAtATime()
  const sent: number[] = []
  expect(guard.run(() => sent.push(1))).toBe(true)
  // El botón aún no se apagó en pantalla y llega el segundo clic.
  expect(guard.run(() => sent.push(2))).toBe(false)
  expect(sent).toEqual([1])
  // Terminado el envío (bien o mal), se puede volver a intentar.
  guard.done()
  expect(guard.run(() => sent.push(3))).toBe(true)
  expect(sent).toEqual([1, 3])
})

it("tras dejar de usar o volver a usar, el foco sigue al formulario a su lugar nuevo", () => {
  // Se dejó de usar: su fila está ahora en «Ya no se usan», y ahí el botón es «Volver a usar».
  expect(rowButtonAfter("leave")).toBe("reuse")
  // Volvió a la lista (o se publicó): en su tarjeta, «Dejar de usar».
  expect(rowButtonAfter("reuse")).toBe("leave")
  expect(rowButtonAfter("publish")).toBe("leave")
})

it("Enter en una pregunta pasa al campo siguiente", () => {
  const stops = ["pregunta", "tipo", "obligatorio", "quitar"]
  expect(nextAfter(stops, "pregunta")).toBe("tipo")
  // En el último no hay a dónde ir: se queda donde está, y tampoco guarda.
  expect(nextAfter(stops, "quitar")).toBeNull()
  expect(nextAfter(stops, "otro")).toBeNull()
})

it("una ficha apagada sigue en la lista, con su versión «sin usar», y no pasa a «Ya no se usan»", () => {
  const off = template({ key: "periodontal", title: "Ficha periodontal", status: "publicado", inUse: false, publishedAt: "2026-11-01T00:00:00Z" })
  expect(versionStatusWords(off)).toBe("sin usar")
  const { listed, unused } = templateGroups([off])
  expect(listed).toHaveLength(1)
  expect(unused).toHaveLength(0)
})

// QA del 14 nov (H2 del novato): una casilla obligatoria sin «No tiene» trababa la ficha en consulta.
it("avisa al hacer obligatoria una pregunta de casillas que no tiene cómo decir «no tiene»", () => {
  expect(requiredWithoutNone({ type: "opcion_multiple", required: true, options: ["Anterior", "Posterior"] })).toBe(true)
  expect(requiredWithoutNone({ type: "opcion_multiple", required: true, options: ["No tiene", "Anterior"] })).toBe(false)
  expect(requiredWithoutNone({ type: "opcion_multiple", required: false, options: ["Anterior"] })).toBe(false)
  expect(requiredWithoutNone({ type: "opcion_unica", required: true, options: ["Sí", "No"] })).toBe(false)
})
