import { readFileSync } from "node:fs"
import { BUNDLED_DIAGNOSIS_LISTS } from "@odentia/db"
import { readZipEntries } from "@odentia/db/xlsx"
import { OPTICAL_SPECIALTIES } from "@odentia/optical"
import { describe, expect, it } from "vitest"
import { DEMO_COUNTRIES } from "../demo-recipes.js"
import { EXPENSE_CATEGORIES } from "../finance.js"
import { ageOn, generator, whoFits } from "../seed-reports.js"
import { OPTICAL_DEMO_KINDS } from "./demo-kinds.js"

/**
 * Las recetas de las demos de vistIA, sin base: lo que piden existe (la
 * biblioteca óptica, las especialidades, la CIE-11 oficial) y lo que escriben va
 * con la edad de cada persona. Armar la demo entera lo prueba
 * `saas-demos-coherence.test.ts`, con base.
 */

/** La biblioteca óptica: clave → nombre, como la carga `seed:procedures`. */
const LIBRARY = new Map(
  readFileSync(new URL("../../../db/seeds/biblioteca_optica.csv", import.meta.url), "utf8")
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => {
      const [key, , , name] = line.split(",")
      return [key as string, name as string] as const
    }),
)

/**
 * Los códigos de la CIE-11 oficial que se cargan en producción: las filas
 * `category` de los capítulos 01 a 25 (la regla de `parseDiagnosisTable`, en
 * `packages/db/src/diagnosis-import.ts`; la cuenta de abajo dice si cambió).
 */
function officialIcd11(): Set<string> {
  const load = BUNDLED_DIAGNOSIS_LISTS.find((item) => item.system === "ICD-11")
  if (!load) throw new Error("falta la CIE-11 oficial")
  const entries = readZipEntries(readFileSync(load.path))
  const table = [...entries].find(([name]) => /\.txt$/i.test(name) && !/readme/i.test(name))
  if (!table) throw new Error("el .zip de la CIE-11 no trae su tabla")
  const lines = table[1].toString("utf8").split(/\r?\n/)
  const header = (lines[0] ?? "").replace(/^﻿/, "").split("\t")
  const codeAt = header.indexOf("Code")
  const kindAt = header.indexOf("ClassKind")
  const chapterAt = header.indexOf("ChapterNo")
  const codes = new Set<string>()
  for (const line of lines.slice(1)) {
    const cells = line.split("\t")
    const code = cells[codeAt]?.trim()
    if (code && cells[kindAt]?.trim() === "category" && /^(0[1-9]|1\d|2[0-5])$/.test(cells[chapterAt]?.trim() ?? ""))
      codes.add(code)
  }
  return codes
}

/** Los tipos de la biblioteca que recibe alguna especialidad de vistIA. */
const KINDS = new Set<string>(OPTICAL_SPECIALTIES.flatMap((item) => item.receives))

describe.each(OPTICAL_DEMO_KINDS.map((kind) => [kind.key, kind] as const))("la receta «%s»", (_key, kind) => {
  it("pide servicios de la biblioteca óptica, con su primera visita, y lo de Inventario cuadra", () => {
    expect(kind.product).toBe("optical")
    const templates = kind.services.map((item) => item.template)
    expect(templates.filter((key) => !LIBRARY.has(key))).toEqual([])
    expect(new Set(templates).size).toBe(templates.length)
    expect(kind.services.filter((item) => item.firstVisit).length).toBeGreaterThan(0)
    expect(kind.promotions.filter((item) => !templates.includes(item.template))).toEqual([])
    const skus = new Set(kind.inventory.products.map((item) => item.sku))
    expect(skus.size).toBe(kind.inventory.products.length)
    expect(Object.keys(kind.inventory.materials).filter((key) => !LIBRARY.has(key))).toEqual([])
    const used = Object.values(kind.inventory.materials).flatMap((items) => items.map((item) => item.sku))
    expect([...used, ...kind.inventory.low, ...kind.inventory.expiring].filter((sku) => !skus.has(sku))).toEqual([])
    expect(kind.expenses.filter((item) => !(EXPENSE_CATEGORIES as readonly string[]).includes(item.category))).toEqual([])
  })

  it("quien atiende tiene un tipo de la biblioteca que recibe una especialidad de vistIA", () => {
    const named = [
      kind.professional.specialty,
      ...(kind.specialtyRotation ?? []),
      ...Object.keys(kind.specialtyWho ?? {}),
      ...kind.services.flatMap((item) => (item.specialty ? [item.specialty] : [])),
    ]
    expect(named.filter((item) => item !== null && !KINDS.has(item))).toEqual([])
  })

  it("Sofi contesta cada primer mensaje sin nombrar sedes ni profesionales", () => {
    expect(kind.reply.length).toBe(kind.inbound.length)
    for (const text of [...kind.inbound, ...kind.reply, ...kind.openTopics]) {
      expect(text).not.toMatch(/sede|\{|\}/i)
      expect(text).not.toMatch(/\b(doctor|doctora|m[eé]dico)\b/i)
    }
  })
})

describe("lo que se escribe en cada atención", () => {
  const official = officialIcd11()
  it("lee la CIE-11 oficial entera", () => {
    // La misma cuenta que carga producción (`diagnosis-codes-official.test.ts`).
    expect(official.size).toBe(17_255)
  })
  // Cuántos años, como mínimo y como máximo, puede tener quien recibe cada diagnóstico.
  const AGES: Record<string, { min?: number; max?: number }> = {
    "9D00.3": { min: 40 },
    "9B10.0Z": { min: 60 },
    "9C60": { min: 40 },
    "9C83.2": { max: 17 },
    "9C80.4": { max: 17 },
  }

  it.each(OPTICAL_DEMO_KINDS.map((kind) => [kind.key, kind] as const))(
    "en «%s», con un diagnóstico de la CIE-11 oficial, a la edad que corresponde y el mismo para cada persona",
    (_key, kind) => {
      const random = generator(20_261_108)
      const at = new Date()
      const written = new Set<string>()
      const wrong: string[] = []
      const refractionOf = new Map<string, Set<string>>()
      for (let index = 0; index < 400; index += 1) {
        const person = kind.person(random, DEMO_COUNTRIES.PE)
        const age = ageOn(person.birthDate, at)
        for (const service of kind.services) {
          if (!whoFits(service.who, person, at)) continue
          const name = LIBRARY.get(service.template) as string
          const note = kind.note({ name }, random, person, at)
          expect(note.evolution.length).toBeGreaterThan(10)
          if (!note.diagnosisCode) continue
          written.add(note.diagnosisCode)
          const limits = AGES[note.diagnosisCode]
          if (limits && ((limits.min !== undefined && age < limits.min) || (limits.max !== undefined && age > limits.max)))
            wrong.push(`${note.diagnosisCode} a los ${age} años (${service.template})`)
          // La miopía, la hipermetropía y el astigmatismo de una persona no cambian entre servicios.
          if (/^9D00\.[012]$/.test(note.diagnosisCode)) {
            const key = `${person.birthDate}:${person.sex}`
            refractionOf.set(key, new Set([...(refractionOf.get(key) ?? []), note.diagnosisCode]))
          }
        }
      }
      expect(written.size).toBeGreaterThan(5)
      expect([...written].filter((code) => !official.has(code))).toEqual([])
      expect(wrong.slice(0, 5)).toEqual([])
      expect([...refractionOf.values()].filter((codes) => codes.size > 1)).toEqual([])
      // Lo del ojo: el capítulo 09 o el examen de la vista (QA00.6).
      expect([...written].filter((code) => !/^9[A-E]|^QA00\.6/.test(code))).toEqual([])
    },
  )
})
