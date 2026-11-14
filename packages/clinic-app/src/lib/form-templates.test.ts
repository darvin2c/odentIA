import { expect, it } from "vitest"
import type { FormSectionDef, FormTemplate } from "./clinical-forms"
import {
  currentLine,
  leaveWords,
  newField,
  publishWords,
  reuseWords,
  sameTitleTemplate,
  settleFieldKeys,
  templateGroups,
  touchesPatients,
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

it("publicar un cuestionario del paciente dice a quién le llega y a cuál reemplaza, con lo que dice el servidor", () => {
  const previo = template({ key: "previo", title: "Cuestionario previo a la cita", respondent: "portal", reachesPatients: true })
  const nuevo = template({ key: "dos", title: "Cuestionario dos", respondent: "portal", status: "borrador", publishedAt: null })
  const previoReach = { key: "previo", title: "Cuestionario previo a la cita" }
  const words = publishWords(nuevo, [previo, nuevo], { now: previoReach, after: { key: "dos", title: "Cuestionario dos" } })
  expect(words).toContain("lo reciben los pacientes con cita por venir")
  expect(words).toContain("en lugar de «Cuestionario previo a la cita»")
  expect(words).not.toContain("en la ficha")
  // El primero de la clínica: no reemplaza a ninguno.
  const first = publishWords(nuevo, [nuevo], { now: null, after: { key: "dos", title: "Cuestionario dos" } })
  expect(first).toContain("lo reciben los pacientes con cita por venir")
  expect(first).not.toContain("en lugar de")
  // La versión siguiente del mismo: reemplaza a su versión anterior.
  const v2 = template({ key: "previo", title: "Cuestionario previo a la cita", respondent: "portal", version: 2, status: "borrador", publishedAt: null })
  expect(publishWords(v2, [previo, v2], { now: previoReach, after: previoReach })).toBe(
    "Desde ese momento los pacientes con cita por venir reciben la versión 2, en lugar de la 1, que se archiva. Lo ya respondido conserva su título y sus preguntas.",
  )
  // Uno del equipo se publica con las palabras de siempre, sin consultar a quién le llega.
  const ficha = template({ key: "ficha", title: "Ficha", status: "borrador", publishedAt: null })
  expect(touchesPatients(ficha, [previo, ficha])).toBe(false)
  expect(publishWords(ficha, [previo, ficha], null)).toBe(
    "Quedará disponible para responder en la ficha. Una versión publicada ya no se edita: para cambiarla se prepara la siguiente.",
  )
  // Sin el dato del servidor (no se pudo consultar) no nombra a ninguno.
  expect(publishWords(nuevo, [previo, nuevo], null)).not.toContain("en lugar de")
})

it("la versión anterior la llenaba el equipo y la nueva la responde el paciente: no dice «en lugar de la 1», que nunca les llegó", () => {
  const fichaV1 = template({ key: "ficha", title: "Ficha de ingreso" })
  const v2 = template({ key: "ficha", title: "Ficha de ingreso", respondent: "portal", version: 2, status: "borrador", publishedAt: null })
  expect(touchesPatients(v2, [fichaV1, v2])).toBe(true)
  const words = publishWords(v2, [fichaV1, v2], { now: null, after: { key: "ficha", title: "Ficha de ingreso" } })
  expect(words).not.toContain("en lugar de")
  expect(words).toBe(
    "Desde ese momento lo reciben los pacientes con cita por venir, para responderlo antes de venir. La versión 1, que llenaba el equipo, se archiva. Lo ya respondido conserva su título y sus preguntas.",
  )
})

it("la nueva versión pasa al equipo y hay otro cuestionario del paciente publicado: dice cuál pasan a recibir", () => {
  const previo = template({ key: "previo", title: "Cuestionario previo a la cita", respondent: "portal" })
  const salud = template({ key: "salud", title: "Cuestionario de salud", respondent: "portal", reachesPatients: true })
  const alEquipo = template({ key: "salud", title: "Cuestionario de salud", version: 2, status: "borrador", publishedAt: null })
  expect(touchesPatients(alEquipo, [previo, salud, alEquipo])).toBe(true)
  const saludReach = { key: "salud", title: "Cuestionario de salud" }
  const previoReach = { key: "previo", title: "Cuestionario previo a la cita" }
  const words = publishWords(alEquipo, [previo, salud, alEquipo], { now: saludReach, after: previoReach })
  expect(words).toContain("dejan de recibirlo y pasan a recibir «Cuestionario previo a la cita»")
  // Sin otro publicado, se quedan sin cuestionario.
  expect(publishWords(alEquipo, [salud, alEquipo], { now: saludReach, after: null })).toContain(
    "no recibirán ningún cuestionario antes de su cita",
  )
  // Si el que les llega hoy es otro, para ellos nada cambia y no se dice que dejan de recibirlo.
  expect(publishWords(alEquipo, [previo, salud, alEquipo], { now: previoReach, after: previoReach })).not.toContain(
    "dejan de recibirlo",
  )
})

it("dejar de usar dice qué deja de pasar y que lo ya llenado no cambia", () => {
  const ficha = template({ key: "periodontal", title: "Ficha periodontal" })
  const staff = leaveWords(ficha, null)
  expect(staff).toContain("Deja de ofrecerse")
  expect(staff).toContain("Lo ya llenado sigue en cada paciente")
  expect(staff).toContain("volver a usarlo")
  // El cuestionario que les llega: dice qué reciben después, con lo que dice el servidor.
  const previo = template({ key: "previo", title: "Cuestionario previo a la cita", respondent: "portal" })
  const salud = template({ key: "salud", title: "Cuestionario de salud", respondent: "portal", reachesPatients: true })
  const saludReach = { key: "salud", title: "Cuestionario de salud" }
  const previoReach = { key: "previo", title: "Cuestionario previo a la cita" }
  expect(leaveWords(salud, { now: saludReach, after: previoReach })).toContain(
    "en su lugar les llegará «Cuestionario previo a la cita»",
  )
  expect(leaveWords(salud, { now: saludReach, after: null })).toContain("no recibirán ningún cuestionario")
  // El que ya no les llega: para los pacientes nada cambia.
  expect(leaveWords(previo, { now: saludReach, after: saludReach })).toContain(
    "reciben «Cuestionario de salud», así que para ellos nada cambia",
  )
})

it("volver a usar uno del equipo no pregunta; uno del paciente dice a cuál reemplaza", () => {
  const ficha = template({ key: "periodontal", title: "Ficha periodontal", status: "archivado" })
  expect(reuseWords(ficha, null)).toBeNull()
  const salud = template({ key: "salud", title: "Cuestionario de salud", respondent: "portal", status: "archivado" })
  const saludReach = { key: "salud", title: "Cuestionario de salud" }
  expect(
    reuseWords(salud, { now: { key: "previo", title: "Cuestionario previo a la cita" }, after: saludReach }),
  ).toContain("en lugar de «Cuestionario previo a la cita»")
  expect(reuseWords(salud, { now: null, after: saludReach })).toBe(
    "Desde ese momento lo reciben los pacientes con cita por venir, con las mismas preguntas.",
  )
})

it("un título que ya tiene otro formulario se avisa, también si está en «Ya no se usan»", () => {
  const endodoncia = template({ key: "endodoncia", title: "Evaluación de endodoncia" })
  const periodontal = template({ key: "periodontal", title: "Ficha periodontal", status: "archivado" })
  const all = [endodoncia, periodontal]
  expect(sameTitleTemplate("Otra ficha", all)).toBeNull()
  expect(sameTitleTemplate("", all)).toBeNull()
  // Sin tildes, mayúsculas ni espacios de más: es el mismo título.
  expect(sameTitleTemplate("  evaluacion de   ENDODONCIA ", all)).toEqual({ title: "Evaluación de endodoncia", unused: null })
  // El que se dejó de usar se ofrece para volver a usarlo.
  expect(sameTitleTemplate("Ficha periodontal", all)).toEqual({
    title: "Ficha periodontal",
    unused: { last: periodontal, leftAt: periodontal.updatedAt },
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
