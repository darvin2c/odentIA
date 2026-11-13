import { expect, it } from "vitest"
import type { FormSectionDef, FormTemplate } from "./clinical-forms"
import {
  currentLine,
  leaveWords,
  newField,
  publishWords,
  reuseWords,
  settleFieldKeys,
  templateGroups,
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

it("publicar un cuestionario del paciente dice a quién le llega y a cuál reemplaza, por su nombre", () => {
  const previo = template({ key: "previo", title: "Cuestionario previo a la cita", respondent: "portal", reachesPatients: true })
  const nuevo = template({ key: "dos", title: "Cuestionario dos", respondent: "portal", status: "borrador", publishedAt: null })
  const words = publishWords(nuevo, [previo, nuevo])
  expect(words).toContain("lo reciben los pacientes con cita por venir")
  expect(words).toContain("en lugar de «Cuestionario previo a la cita»")
  expect(words).not.toContain("en la ficha")
  // El primero de la clínica: no reemplaza a ninguno.
  expect(publishWords(nuevo, [nuevo])).toContain("lo reciben los pacientes con cita por venir")
  expect(publishWords(nuevo, [nuevo])).not.toContain("en lugar de")
  // La versión siguiente del mismo: reemplaza a su versión anterior.
  const v2 = template({ key: "previo", title: "Cuestionario previo a la cita", respondent: "portal", version: 2, status: "borrador", publishedAt: null })
  expect(publishWords(v2, [previo, v2])).toBe(
    "Desde ese momento los pacientes con cita por venir reciben la versión 2, en lugar de la 1, que se archiva. Lo ya respondido conserva su título y sus preguntas.",
  )
  // Si la versión nueva pasa a llenarla el equipo, los pacientes dejan de recibirlo.
  const alEquipo = { ...v2, respondent: "staff" as const }
  expect(publishWords(alEquipo, [previo, alEquipo])).toContain("los pacientes dejan de recibirlo")
  // Uno del equipo se publica con las palabras de siempre.
  const ficha = template({ key: "ficha", title: "Ficha", status: "borrador", publishedAt: null })
  expect(publishWords(ficha, [previo, ficha])).toBe(
    "Quedará disponible para responder en la ficha. Una versión publicada ya no se edita: para cambiarla se prepara la siguiente.",
  )
})

it("dejar de usar dice qué deja de pasar y que lo ya llenado no cambia", () => {
  const ficha = template({ key: "periodontal", title: "Ficha periodontal" })
  const staff = leaveWords(ficha, [ficha])
  expect(staff).toContain("Deja de ofrecerse")
  expect(staff).toContain("Lo ya llenado sigue en cada paciente")
  expect(staff).toContain("volver a usarlo")
  // El cuestionario que les llega: dicen qué reciben después.
  const previo = template({ key: "previo", title: "Cuestionario previo a la cita", respondent: "portal" })
  const salud = template({ key: "salud", title: "Cuestionario de salud", respondent: "portal", reachesPatients: true })
  expect(leaveWords(salud, [previo, salud])).toContain("en su lugar les llegará «Cuestionario previo a la cita»")
  expect(leaveWords(salud, [salud])).toContain("no recibirán ningún cuestionario")
  // El que ya no les llega: para los pacientes nada cambia.
  expect(leaveWords(previo, [previo, salud])).toContain("reciben «Cuestionario de salud», así que para ellos nada cambia")
})

it("volver a usar uno del equipo no pregunta; uno del paciente dice a cuál reemplaza", () => {
  const ficha = template({ key: "periodontal", title: "Ficha periodontal", status: "archivado" })
  expect(reuseWords(ficha, [ficha])).toBeNull()
  const previo = template({ key: "previo", title: "Cuestionario previo a la cita", respondent: "portal", reachesPatients: true })
  const salud = template({ key: "salud", title: "Cuestionario de salud", respondent: "portal", status: "archivado" })
  expect(reuseWords(salud, [previo, salud])).toContain("en lugar de «Cuestionario previo a la cita»")
  expect(reuseWords(salud, [salud])).toBe(
    "Desde ese momento lo reciben los pacientes con cita por venir, con las mismas preguntas.",
  )
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
