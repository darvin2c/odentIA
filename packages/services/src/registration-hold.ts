import {
  type ClinicalCountryProfile,
  composeDisplayName,
  countryDisplayName,
  documentText,
  EDUCATION_LEVEL_LABELS,
  INSURANCE_TYPE_LABELS,
  insuranceScheme,
  isMinor,
  isRealDate,
  KINSHIP_LABELS,
  MARITAL_STATUS_LABELS,
  normalizePhone,
  postalAddressText,
  REFERRAL_KIND_LABELS,
  type RegistrationAnswers,
  SEX_LABELS,
} from "@odentia/clinical"
import { createHash } from "node:crypto"

/**
 * «¿Es la misma persona?» (lo que dejó el registro en línea para recepción):
 * lo que escribió hoy al lado de lo que ya estaba, dato por dato, como quien
 * revisa cambios antes de aceptarlos. Lo que va junto se revisa junto (la
 * dirección entera, el seguro entero, nombres y apellidos), para no mezclar
 * la calle de hoy con el distrito de antes.
 */
export const HOLD_GROUPS = [
  "names",
  "birthDate",
  "sex",
  "phone",
  "email",
  "address",
  "insurance",
  "emergency",
  "nationality",
  "birthPlace",
  "maritalStatus",
  "educationLevel",
  "occupation",
  "origin",
  "referral",
] as const
export type HoldGroup = (typeof HOLD_GROUPS)[number]

const GROUP_FIELDS: Record<HoldGroup, readonly string[]> = {
  names: ["givenNames", "familyName"],
  birthDate: ["birthDate"],
  sex: ["sex"],
  phone: ["phone"],
  email: ["email"],
  address: ["address", "addressReference", "addressCity", "addressDistrict", "addressRegion", "addressPostalCode", "addressCountry"],
  insurance: ["insuranceType", "insuranceScheme", "insurerName", "affiliationNumber"],
  emergency: ["emergencyContactName", "emergencyContactPhone", "emergencyContactRelationship"],
  nationality: ["nationality"],
  birthPlace: ["birthPlace", "birthCountry"],
  maritalStatus: ["maritalStatus"],
  educationLevel: ["educationLevel"],
  occupation: ["occupation"],
  origin: ["origin"],
  referral: ["referralKind", "referralSource"],
}

const GROUP_LABELS: Record<HoldGroup, string> = {
  names: "Nombres y apellidos",
  birthDate: "Nacimiento",
  sex: "Sexo",
  phone: "Celular",
  email: "Correo",
  address: "Dirección",
  insurance: "Seguro",
  emergency: "Contacto de emergencia",
  nationality: "Nacionalidad",
  birthPlace: "Lugar de nacimiento",
  maritalStatus: "Estado civil",
  educationLevel: "Nivel educativo",
  occupation: "Ocupación",
  origin: "Procedencia",
  referral: "Cómo nos conoció",
}

/**
 * Quién es y por dónde se le escribe: vienen sin marcar. Con el documento de
 * otra persona, marcarlos sin mirar le daría a quien se registró las citas,
 * el enlace y las recetas de esa persona; el nacimiento y el sexo cambian
 * dosis y quién firma por un menor. Los marca quien comprobó que es ella.
 */
export const CAREFUL_GROUPS: ReadonlySet<HoldGroup> = new Set(["names", "birthDate", "sex", "phone", "email"])

/** Una fila: lo que escribió hoy y lo que ya estaba, con palabras. */
export interface RegistrationHoldRow {
  key: HoldGroup | "document"
  label: string
  /** La pantalla da formato al celular y a la fecha con los de la clínica. */
  format: "text" | "phone" | "date"
  /** Lo que escribió hoy. */
  declared: string | null
  /** Lo que ya estaba (nulo si no lo tenía). */
  saved: string | null
  /** Igual, nuevo (no lo tenía) o distinto. */
  state: "same" | "new" | "changed"
  /** Si no se puede guardar desde aquí, por qué. */
  blocked: string | null
  /** Viene marcado: lo administrativo sí; quién es y por dónde se le escribe, no. */
  checked: boolean
}

type Values = Record<string, unknown>

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ") : null

function sameValue(field: string, a: string, b: string, country: string | null): boolean {
  if (field === "phone" || field === "emergencyContactPhone") {
    const left = normalizePhone(a, country) ?? a.replace(/\D/g, "")
    const right = normalizePhone(b, country) ?? b.replace(/\D/g, "")
    return left === right
  }
  return a.localeCompare(b, "es", { sensitivity: "base" }) === 0
}

const labelOf = (labels: Record<string, string>, value: string | null) => (value ? (labels[value] ?? value) : null)
const join = (parts: Array<string | null | undefined>, separator = " · ") => parts.filter(Boolean).join(separator) || null

/** Un grupo dicho en una línea, como se lee en la ficha. */
function groupText(group: HoldGroup, values: Values, profile: ClinicalCountryProfile, displayName?: string | null): string | null {
  const v = (key: string) => text(values[key])
  switch (group) {
    case "names":
      return composeDisplayName({ givenNames: v("givenNames"), familyName: v("familyName") }) || text(displayName) || null
    case "sex":
      return labelOf(SEX_LABELS, v("sex"))
    case "address":
      return postalAddressText(
        profile,
        { line: v("address"), city: v("addressCity"), district: v("addressDistrict"), region: v("addressRegion"), postalCode: v("addressPostalCode"), country: v("addressCountry") },
        { reference: v("addressReference") },
      )
    case "insurance":
      return join([
        labelOf(INSURANCE_TYPE_LABELS, v("insuranceType")),
        insuranceScheme(profile, v("insuranceScheme"))?.label ?? v("insuranceScheme"),
        v("insurerName"),
        v("affiliationNumber") ? `N.º ${v("affiliationNumber")}` : null,
      ])
    case "emergency":
      return join([v("emergencyContactName"), v("emergencyContactPhone"), labelOf(KINSHIP_LABELS, v("emergencyContactRelationship"))])
    case "nationality":
      return v("nationality") ? countryDisplayName(v("nationality")!.toUpperCase()) : null
    case "birthPlace":
      return join([v("birthPlace"), v("birthCountry") ? countryDisplayName(v("birthCountry")!.toUpperCase()) : null], ", ")
    case "maritalStatus":
      return labelOf(MARITAL_STATUS_LABELS, v("maritalStatus"))
    case "educationLevel":
      return labelOf(EDUCATION_LEVEL_LABELS, v("educationLevel"))
    case "referral":
      return join([labelOf(REFERRAL_KIND_LABELS, v("referralKind")), v("referralSource")], ": ")
    default:
      return join(GROUP_FIELDS[group].map((field) => v(field)))
  }
}

/**
 * Las filas de «¿Es la misma persona?». `saved` es lo que ya tiene la persona
 * (su ficha si es paciente, con su contacto de emergencia); `today`, el día de
 * la clínica. Solo aparece lo que escribió: lo que no dijo no se compara.
 */
export function registrationHoldRows(
  answers: RegistrationAnswers,
  saved: Values,
  options: { profile: ClinicalCountryProfile; today: string },
): RegistrationHoldRow[] {
  const declared = answers.demographics as Values
  const { profile, today } = options
  const rows: RegistrationHoldRow[] = []
  for (const group of HOLD_GROUPS) {
    const fields = GROUP_FIELDS[group]
    const said = fields.filter((field) => text(declared[field]) !== null)
    if (said.length === 0) continue
    // El nombre se compara entero, también con el que solo se guardó como nombre visible.
    const savedName = group === "names" ? groupText("names", saved, profile, text(saved.displayName)) : null
    const had = group === "names" ? savedName !== null : fields.some((field) => text(saved[field]) !== null)
    const same =
      group === "names"
        ? savedName !== null && sameValue("names", groupText("names", declared, profile) ?? "", savedName, profile.country)
        : said.every((field) => {
            const before = text(saved[field])
            return before !== null && sameValue(field, text(declared[field])!, before, profile.country)
          })
    const state = same ? "same" : had ? "changed" : "new"
    const birth = text(declared.birthDate)
    // Su contacto de emergencia también es paciente: el teléfono de esa persona es suyo y no se cambia desde aquí.
    const emergencyPhoneOfPatient =
      group === "emergency" &&
      saved.emergencyContactIsPatient === true &&
      sameValue("emergencyContactName", text(declared.emergencyContactName) ?? "", text(saved.emergencyContactName) ?? "", profile.country) &&
      text(declared.emergencyContactPhone) !== null &&
      !sameValue("emergencyContactPhone", text(declared.emergencyContactPhone)!, text(saved.emergencyContactPhone) ?? "", profile.country)
    const blocked =
      group === "birthDate" && state !== "same" && birth && isRealDate(birth) && isMinor(birth, today)
        ? "Con esa fecha es menor de edad: cámbiala en sus datos, junto con su representante."
        : emergencyPhoneOfPatient
          ? "Su contacto de emergencia también es paciente: su teléfono se cambia en su propia página."
          : null
    rows.push({
      key: group,
      label: GROUP_LABELS[group],
      format: group === "phone" ? "phone" : group === "birthDate" ? "date" : "text",
      declared: groupText(group, declared, profile),
      saved: groupText(group, saved, profile, group === "names" ? text(saved.displayName) : null),
      state,
      blocked,
      checked: state !== "same" && !blocked && !CAREFUL_GROUPS.has(group),
    })
  }
  // El documento se muestra para comparar, pero nunca se guarda desde aquí: es lo que la identifica.
  const docNumber = text(declared.docNumber)
  if (docNumber) {
    const doc = documentText(String(declared.docType ?? ""), docNumber)
    const savedDoc = text(saved.docNumber) ? documentText(String(saved.docType ?? ""), String(saved.docNumber)) : null
    const state = savedDoc === null ? "new" : sameValue("docNumber", docNumber, String(saved.docNumber), null) && (text(saved.docType) ?? "") === (text(declared.docType) ?? "") ? "same" : "changed"
    rows.push({
      key: "document",
      label: "Documento",
      format: "text",
      declared: doc,
      saved: savedDoc,
      state,
      blocked: state === "same" ? null : "El documento no se cambia desde aquí: si hace falta, cámbialo en sus datos.",
      checked: false,
    })
  }
  return rows
}

/** Los datos que escribió de cada grupo marcado, listos para guardar (lo que no dijo queda vacío). */
export function registrationHoldPatch(answers: RegistrationAnswers, groups: readonly HoldGroup[]): Values {
  const declared = answers.demographics as Values
  const patch: Values = {}
  for (const group of groups) for (const field of GROUP_FIELDS[group]) patch[field] = text(declared[field])
  return patch
}

/**
 * Huella de lo que recepción tiene a la vista: si la persona o lo que escribió
 * cambian mientras lo revisa, guardar se rechaza en vez de pisar algo que no vio.
 */
export function registrationHoldRevision(holdId: string, rows: RegistrationHoldRow[]): string {
  return createHash("sha256")
    .update(JSON.stringify([holdId, rows.map((row) => [row.key, row.declared, row.saved, row.blocked])]))
    .digest("base64url")
    .slice(0, 32)
}

/** Lo de antes, para la nota de la persona: «celular (antes +51 993 029 296)». */
export function replacedWords(rows: RegistrationHoldRow[], applied: readonly HoldGroup[]): string | null {
  const replaced = rows.filter((row) => row.state === "changed" && applied.includes(row.key as HoldGroup) && row.saved)
  if (replaced.length === 0) return null
  const shown = (row: RegistrationHoldRow) =>
    row.format === "date" && /^\d{4}-\d{2}-\d{2}$/.test(row.saved ?? "") ? row.saved!.split("-").reverse().join("/") : row.saved
  return replaced.map((row) => `${row.label.toLowerCase()} (antes ${shown(row)})`).join("; ")
}
