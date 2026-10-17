/**
 * Solo para pruebas: inserta fichas de paciente directamente, como hacían las
 * pruebas antes de que la identidad viviera solo en la persona (ADR 0044). La
 * identidad que traen los valores se guarda en una persona nueva —o en la que
 * se indica con `personId`— y la ficha apunta a ella; la base crea su vínculo
 * propio. No pasa por las reglas de `createPatient`: es para preparar datos.
 */
import type { Db } from "@odentia/db"
import { patient } from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { and, eq } from "drizzle-orm"
import { joinPatientPerson, PATIENT_IDENTITY_KEYS, patientRowColumns, type PatientRow } from "./patient-identity.js"

type PatientInsert = typeof patient.$inferInsert
type ContactInsert = typeof contact.$inferInsert

export type TestPatientValues = Omit<PatientInsert, "personId"> & {
  personId?: string
  displayName?: string
  givenNames?: string | null
  paternalSurname?: string | null
  maternalSurname?: string | null
  identityNeedsReview?: boolean
  docType?: string | null
  docNumber?: string | null
  docCountry?: string | null
  birthDate?: string | null
  sex?: string | null
  phone?: string | null
  email?: string | null
  isActive?: boolean
}

/** Solo para pruebas: las fichas con su identidad, para encadenar `.where(...)` como antes. */
export function selectTestPatients(db: Db) {
  return db.select(patientRowColumns()).from(patient).innerJoin(contact, joinPatientPerson())
}

/** Solo para pruebas: cambia directamente la identidad de un paciente, que vive en su persona. */
export async function setTestPatientIdentity(
  db: Db,
  patientId: string,
  set: Partial<Pick<ContactInsert, "displayName" | "givenNames" | "paternalSurname" | "maternalSurname" | "identityNeedsReview" | "docType" | "docNumber" | "docCountry" | "birthDate" | "sex" | "phone" | "email" | "isActive">>,
): Promise<void> {
  const [row] = await db.select({ personId: patient.personId }).from(patient).where(eq(patient.id, patientId))
  if (!row) throw new Error("Paciente de prueba inexistente")
  await db.update(contact).set(set).where(eq(contact.id, row.personId))
}

export async function insertTestPatients(
  db: Db,
  values: TestPatientValues | TestPatientValues[],
): Promise<PatientRow[]> {
  const list = Array.isArray(values) ? values : [values]
  const rows: PatientRow[] = []
  for (const value of list) {
    const identity: Record<string, unknown> = {}
    const record: Record<string, unknown> = {}
    for (const [key, field] of Object.entries(value)) {
      if (key === "personId") continue
      if ((PATIENT_IDENTITY_KEYS as readonly string[]).includes(key) || key === "isActive") identity[key] = field
      else record[key] = field
    }
    let personId = value.personId
    if (personId) {
      if (Object.keys(identity).length)
        await db
          .update(contact)
          .set(identity as Partial<ContactInsert>)
          .where(and(eq(contact.organizationId, value.organizationId), eq(contact.id, personId)))
    } else {
      const [person] = await db
        .insert(contact)
        .values({
          ...(identity as Partial<ContactInsert>),
          organizationId: value.organizationId,
          displayName: (identity.displayName as string | undefined) ?? "Paciente de prueba",
        })
        .returning({ id: contact.id })
      personId = person!.id
    }
    const [row] = await db
      .insert(patient)
      .values({ ...(record as Omit<PatientInsert, "personId">), personId })
      .returning()
    const [person] = await db.select().from(contact).where(eq(contact.id, personId))
    rows.push({
      ...row!,
      displayName: person!.displayName,
      givenNames: person!.givenNames,
      paternalSurname: person!.paternalSurname,
      maternalSurname: person!.maternalSurname,
      identityNeedsReview: person!.identityNeedsReview,
      docType: person!.docType,
      docNumber: person!.docNumber,
      docCountry: person!.docCountry,
      birthDate: person!.birthDate,
      sex: person!.sex,
      phone: person!.phone,
      email: person!.email,
      isActive: person!.isActive,
    })
  }
  return rows
}
