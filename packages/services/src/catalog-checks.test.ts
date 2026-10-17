/**
 * Cada lista cerrada de la base (su CHECK) dice lo mismo que su constante:
 * la que importan los servicios y las pantallas. Antes se copiaban a mano y ya
 * diferían (el filtro por sexo aceptaba solo M y F; los formularios no tenían
 * «descartado»). Si una lista cambia, esta prueba pide cambiar la otra.
 */
import {
  CONDITION_STATUSES,
  CONTACT_RELATIONSHIPS,
  EDUCATION_LEVELS,
  FOLLOW_UP_STATUSES,
  HL7_MARITAL_STATUSES,
  INSURANCE_TYPES,
  KINSHIP,
  PATIENT_DOCUMENT_CATEGORIES,
  RESPONSIBILITY_KINDS,
  SEX_CODES,
} from "@odentia/clinical"
import { APPOINTMENT_STATUSES } from "@odentia/db/schema/agenda"
import { FORM_RESPONSE_STATUSES } from "@odentia/db/schema/clinical-forms"
import { sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { FAMILY_RELATIONSHIPS } from "./clinical.js"
import { PAYMENT_TYPE_CODES } from "./payment-methods.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const LISTS: Array<[constraint: string, values: readonly string[]]> = [
  ["patient_sex_check", SEX_CODES],
  ["contact_sex_check", SEX_CODES],
  ["patient_contact_kinship_check", KINSHIP],
  ["patient_contact_relationship_check", CONTACT_RELATIONSHIPS],
  // Lo nacional (`PE:conviviente`) entra por un patrón, no por la lista.
  ["patient_marital_status_check", HL7_MARITAL_STATUSES],
  ["patient_education_level_check", EDUCATION_LEVELS],
  ["patient_insurance_type_check", INSURANCE_TYPES],
  ["patient_family_history_relationship_check", FAMILY_RELATIONSHIPS],
  ["patient_condition_status_check", CONDITION_STATUSES],
  ["patient_responsibility_kind_check", RESPONSIBILITY_KINDS],
  ["clinical_follow_up_status_check", FOLLOW_UP_STATUSES],
  ["patient_document_category_check", PATIENT_DOCUMENT_CATEGORIES],
  ["clinical_form_response_status_check", FORM_RESPONSE_STATUSES],
  ["appointment_status_check", APPOINTMENT_STATUSES],
  ["patient_payment_method_type_check", PAYMENT_TYPE_CODES],
]

it("cada CHECK de una lista cerrada coincide con la constante que usan servicios y pantallas", async () => {
  const rows = await ownerDb.execute<{ name: string; definition: string }>(sql`
    select conname as name, pg_get_constraintdef(oid) as definition from pg_constraint
    where contype = 'c' and conname in (${sql.join(
      LISTS.map(([name]) => sql`${name}`),
      sql`, `,
    )})`)
  const byName = new Map(rows.map((row) => [row.name, row.definition]))
  for (const [name, values] of LISTS) {
    const definition = byName.get(name)
    expect(definition, `falta el CHECK ${name}`).toBeDefined()
    // Los valores entre comillas; un patrón (`^[A-Z]{2}:…`) no es un valor de la lista.
    const inBase = [...(definition ?? "").matchAll(/'([^']*)'::/g)]
      .map((match) => match[1] ?? "")
      .filter((value) => !value.startsWith("^"))
    expect([...new Set(inBase)].sort(), name).toEqual([...new Set(values)].sort())
  }
})
