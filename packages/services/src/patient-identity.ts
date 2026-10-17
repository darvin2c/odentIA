/**
 * La identidad de un paciente es la de su persona (ADR 0001 y 0044): la ficha
 * (`patient`) guarda lo clínico y administrativo y apunta a la persona con
 * `person_id`. Aquí viven las piezas para leerla: la unión con la persona, las
 * columnas de identidad con los nombres de siempre y la fila de la ficha con
 * su identidad (`PatientRow`), para que quien lee un paciente no tenga que
 * saber dónde vive cada dato.
 */
import { patient } from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { and, eq, getTableColumns, type SQL } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"

/** La persona de un paciente cuando la consulta ya usa `contact` para otra persona. */
export const patientPerson = alias(contact, "patient_person")

type PersonTable = typeof contact | typeof patientPerson

/** Une la ficha con su persona (la misma organización, por la clave compuesta). */
export function joinPatientPerson(person: PersonTable = contact): SQL {
  return and(eq(person.organizationId, patient.organizationId), eq(person.id, patient.personId))!
}

/** Las columnas de identidad, leídas de la persona, con los nombres que tenían en la ficha. */
export function patientIdentityColumns(person: PersonTable = contact) {
  return {
    displayName: person.displayName,
    givenNames: person.givenNames,
    paternalSurname: person.paternalSurname,
    maternalSurname: person.maternalSurname,
    identityNeedsReview: person.identityNeedsReview,
    docType: person.docType,
    docNumber: person.docNumber,
    docCountry: person.docCountry,
    birthDate: person.birthDate,
    sex: person.sex,
    phone: person.phone,
    email: person.email,
    isActive: person.isActive,
  }
}

/** La ficha entera con su identidad: lo que antes era una fila de `patient`. */
export function patientRowColumns(person: PersonTable = contact) {
  return { ...getTableColumns(patient), ...patientIdentityColumns(person) }
}

export type PatientIdentity = {
  displayName: string
  givenNames: string | null
  paternalSurname: string | null
  maternalSurname: string | null
  identityNeedsReview: boolean
  docType: string | null
  docNumber: string | null
  docCountry: string | null
  birthDate: string | null
  sex: string | null
  phone: string | null
  email: string | null
  isActive: boolean
}

export type PatientRow = typeof patient.$inferSelect & PatientIdentity

/** Campos de identidad que se escriben en la persona (el resto de la ficha va a `patient`). */
export const PATIENT_IDENTITY_KEYS = [
  "displayName",
  "givenNames",
  "paternalSurname",
  "maternalSurname",
  "identityNeedsReview",
  "docType",
  "docNumber",
  "docCountry",
  "birthDate",
  "sex",
  "phone",
  "email",
] as const
