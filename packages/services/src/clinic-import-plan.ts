/**
 * El plan de carga de una clínica (ADR 0104): las personas y los pacientes que
 * trae una clínica nueva, ya leídos de sus archivos. Lo arma la skill de carga
 * (`clinic-import-prepare.ts`) en la máquina de quien acompaña el alta y lo
 * aplica la administración (`clinic-import.ts`): primero un ensayo que no
 * guarda nada y después la carga por tandas.
 *
 * Este archivo no toca la base: dice qué filas no se pueden cargar y cuáles
 * conviene revisar con las mismas reglas de «Nuevo paciente»
 * (`validateDemographics`). Nunca une a dos personas por su teléfono o su
 * nombre: lo parecido se avisa y lo decide una persona.
 */
import { createHash } from "node:crypto"
import {
  clinicalProfileFor,
  demographicsSchema,
  documentIssuerCountry,
  isMinor,
  KINSHIP,
  normalizePhone,
  validateDemographics,
} from "@odentia/clinical"
import { z } from "zod"

export const CLINIC_IMPORT_VERSION = 1
/** Personas por plan: una clínica grande se carga en dos planes. */
export const CLINIC_IMPORT_MAX_PEOPLE = 10_000

const keySchema = z.string().trim().min(1, "Cada fila necesita su clave").max(120)

/**
 * Los datos de una persona: los de «Nuevo paciente», sin salud ni seguro.
 * Quien no es paciente (la madre que habla por su hijo) guarda solo su
 * identidad y cómo ubicarla.
 */
export const clinicImportDemographicsSchema = demographicsSchema.pick({
  displayName: true,
  givenNames: true,
  familyName: true,
  birthDate: true,
  docType: true,
  docNumber: true,
  docCountry: true,
  sex: true,
  phone: true,
  email: true,
  address: true,
  addressDistrict: true,
  addressCity: true,
  addressRegion: true,
})
export type ClinicImportDemographics = z.infer<typeof clinicImportDemographicsSchema>

/** Lo que de una persona que no es paciente se guarda (`createPerson`). */
const PERSON_ONLY_FIELDS = ["address", "addressDistrict", "addressCity", "addressRegion"] as const

export const clinicImportPersonSchema = z.strictObject({
  /**
   * Clave estable de la fila en el origen (su número de historia, o la que
   * asigna la preparación). Cargar otra vez la misma clave no crea otra ficha.
   */
  key: keySchema,
  /** Con ficha de paciente; sin ella, solo la persona. */
  patient: z.boolean(),
  demographics: clinicImportDemographicsSchema,
  /** Quien habla por ella: otra persona del plan, que se carga antes. */
  guardian: z
    .strictObject({
      key: keySchema,
      relationship: z.enum(["guardian", "family", "other"]),
      kinship: z.enum(KINSHIP).nullable().optional(),
    })
    .optional(),
  /** De qué archivo y fila salió, para encontrarla en el original. */
  origin: z.strictObject({ file: z.string().trim().min(1).max(200), row: z.number().int().min(1) }).optional(),
})
export type ClinicImportPerson = z.infer<typeof clinicImportPersonSchema>

export const clinicImportPlanSchema = z.strictObject({
  version: z.literal(CLINIC_IMPORT_VERSION),
  /** País de la clínica (ISO 3166-1): con él se leen documentos y teléfonos. */
  countryCode: z.string().regex(/^[A-Z]{2}$/, "País ISO de 2 letras en mayúsculas"),
  /** De qué archivos salió el plan: su nombre y su huella, sin datos de personas. */
  sources: z
    .array(z.strictObject({ name: z.string().trim().min(1).max(200), sha256: z.string().regex(/^[0-9a-f]{64}$/) }))
    .min(1)
    .max(20),
  people: z.array(clinicImportPersonSchema).min(1).max(CLINIC_IMPORT_MAX_PEOPLE),
  /**
   * Filas del origen que la preparación dejó fuera y por qué, sin sus datos:
   * la conciliación cuenta cada fila, también las que no entran.
   */
  omitted: z
    .array(z.strictObject({ file: z.string().trim().min(1).max(200), row: z.number().int().min(1), reason: z.string().trim().min(1).max(300) }))
    .max(CLINIC_IMPORT_MAX_PEOPLE)
    .default([]),
})
export type ClinicImportPlan = z.infer<typeof clinicImportPlanSchema>

/** Lo que se dice de una fila: `error` no se carga; `aviso` se carga y conviene revisarlo. */
export interface ClinicImportIssue {
  key: string
  level: "error" | "aviso"
  /** El dato al que se refiere, si es uno (`birthDate`, `phone`…). */
  field?: string
  message: string
}

export interface ClinicImportCheck {
  /** Las claves en el orden en que se cargan: primero quien habla por otra persona. */
  order: string[]
  issues: ClinicImportIssue[]
  /** Claves que no se cargan (tienen al menos un error). */
  blocked: string[]
}

/** Huella del plan: la que queda en la auditoría y en cada fila cargada. */
export function clinicImportPlanSha256(plan: ClinicImportPlan): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex")
}

/** Un nombre para comparar: sin tildes, en minúsculas y con un espacio entre palabras. */
export function foldName(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim()
}

function nameOf(person: ClinicImportPerson): string {
  const { givenNames, familyName, displayName } = person.demographics
  return [givenNames, familyName].filter(Boolean).join(" ") || displayName
}

/**
 * Revisa el plan entero antes de tocar la base: las reglas de cada persona,
 * las claves, quién habla por quién y lo que se repite dentro del plan.
 * `today` es el día de la clínica (`YYYY-MM-DD`).
 */
export function checkClinicImportPlan(plan: ClinicImportPlan, today: string): ClinicImportCheck {
  const issues: ClinicImportIssue[] = []
  const error = (key: string, message: string, field?: string) => issues.push({ key, level: "error", message, ...(field ? { field } : {}) })
  const aviso = (key: string, message: string, field?: string) => issues.push({ key, level: "aviso", message, ...(field ? { field } : {}) })
  const profile = clinicalProfileFor(plan.countryCode)

  const byKey = new Map<string, ClinicImportPerson>()
  for (const person of plan.people) {
    if (byKey.has(person.key)) {
      error(person.key, `La clave «${person.key}» se repite: cada fila necesita la suya`)
      continue
    }
    byKey.set(person.key, person)
    for (const [field, message] of Object.entries(validateDemographics(person.demographics, today, plan.countryCode)))
      error(person.key, message, field)
    if (!person.patient && PERSON_ONLY_FIELDS.some((field) => person.demographics[field]))
      aviso(person.key, "No es paciente: su dirección no se guarda", "address")
  }

  // Quien habla por ella: tiene que estar en el plan y no puede ser ella misma ni cerrar un círculo.
  for (const person of byKey.values()) {
    const guardianKey = person.guardian?.key
    if (!guardianKey) continue
    if (guardianKey === person.key) error(person.key, "No puede hablar por sí misma: quita a quien habla por ella")
    else if (!byKey.has(guardianKey)) error(person.key, `Quien habla por ella («${guardianKey}») no está en el plan`)
  }
  const order: string[] = []
  const state = new Map<string, "visiting" | "done">()
  const visit = (key: string): boolean => {
    if (state.get(key) === "done") return true
    if (state.get(key) === "visiting") return false
    state.set(key, "visiting")
    const guardianKey = byKey.get(key)?.guardian?.key
    const ok = !guardianKey || guardianKey === key || !byKey.has(guardianKey) || visit(guardianKey)
    state.set(key, "done")
    order.push(key)
    return ok
  }
  for (const key of byKey.keys()) {
    if (!visit(key)) error(key, "Quién habla por quién forma un círculo: revisa a quien habla por ella")
  }

  // El documento identifica a una sola persona: dentro del plan no se repite.
  const documents = new Map<string, string>()
  for (const person of byKey.values()) {
    const { docType, docNumber, docCountry } = person.demographics
    if (!docType || !docNumber) continue
    const doc = `${documentIssuerCountry(profile, docType, docCountry) ?? ""}|${docType}|${docNumber.trim().toUpperCase()}`
    const first = documents.get(doc)
    if (first) error(person.key, `Ese documento ya está en la fila de ${nameOf(byKey.get(first)!)} («${first}»)`, "docNumber")
    else documents.set(doc, person.key)
  }

  // Parecidos que decide una persona: nunca se unen solos.
  const byName = new Map<string, ClinicImportPerson[]>()
  for (const person of byKey.values()) {
    const name = foldName(nameOf(person))
    byName.set(name, [...(byName.get(name) ?? []), person])
  }
  for (const group of byName.values()) {
    for (const [index, person] of group.entries()) {
      const twin = group.slice(0, index).find((other) => {
        const a = other.demographics.birthDate
        const b = person.demographics.birthDate
        return !a || !b || a === b
      })
      if (twin) aviso(person.key, `Se llama igual que «${twin.key}»: revisa si es la misma persona antes de cargar`)
    }
  }
  const byPhone = new Map<string, ClinicImportPerson[]>()
  for (const person of byKey.values()) {
    const phone = normalizePhone(person.demographics.phone, plan.countryCode)
    if (phone) byPhone.set(phone, [...(byPhone.get(phone) ?? []), person])
  }
  for (const group of byPhone.values()) {
    for (const person of group.slice(1)) {
      const related = group.some((other) => other !== person && (other.guardian?.key === person.key || person.guardian?.key === other.key))
      if (!related) aviso(person.key, `Comparte el teléfono con «${group[0]!.key}»: quedan como personas distintas`, "phone")
    }
  }

  // Lo que queda incompleto se carga igual y queda en «Faltan datos».
  for (const person of byKey.values()) {
    if (!person.patient) continue
    const { birthDate, givenNames, familyName, phone, email } = person.demographics
    const guardian = person.guardian ? byKey.get(person.guardian.key) : undefined
    if (!birthDate) aviso(person.key, "Sin fecha de nacimiento: quedará en «Faltan datos»", "birthDate")
    else if (!person.guardian && isMinor(birthDate, today)) aviso(person.key, "Es menor de edad y nadie habla por ella", "guardian")
    if (!givenNames || !familyName) aviso(person.key, "Nombres y apellidos sin separar: quedará en «Faltan datos»", "givenNames")
    if (!phone && !email && !guardian?.demographics.phone && !guardian?.demographics.email)
      aviso(person.key, "Sin teléfono ni correo, ni de quien habla por ella: no recibirá avisos", "phone")
  }

  // Si quien habla por ella no se carga, ella tampoco: el vínculo se perdería.
  const blocked = new Set(issues.filter((issue) => issue.level === "error").map((issue) => issue.key))
  for (const key of order) {
    const guardianKey = byKey.get(key)?.guardian?.key
    if (guardianKey && guardianKey !== key && blocked.has(guardianKey) && !blocked.has(key)) {
      error(key, `No se carga porque quien habla por ella («${guardianKey}») tiene errores`, "guardian")
      blocked.add(key)
    }
  }
  return { order, issues, blocked: [...blocked] }
}
