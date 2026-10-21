/**
 * Cómo se dicen y se eligen los datos de la persona según el país de la
 * clínica (ADR 0036): documentos, seguro, dirección y países. Las reglas viven
 * en `@odentia/clinical` (`clinicalProfileFor`) y las valida el servidor; aquí
 * solo se les pone nombre para la pantalla.
 */
import {
  type ClinicalCountryProfile,
  DOC_TYPE_LABELS,
  documentTypeProfile,
  type IdentityDocType,
  INSURANCE_TYPE_LABELS,
  type InsuranceType,
  MARITAL_STATUS_LABELS,
  type MaritalStatus,
  insuranceScheme,
  REFERRAL_KIND_LABELS,
  postalAddressText,
  type ReferralKind,
  regionName,
} from "@odentia/clinical"
import { countryOptions, normalizeCountry, regionCountry } from "@odentia/ui-patterns"
import { activeOrgLocale } from "./locale"
import { countryName, displayLanguage } from "./region-format"

/** Nombre de un país en el idioma de la clínica (CLDR, vía `Intl.DisplayNames`). */
export function countryText(code: string | null | undefined): string | null {
  if (!code) return null
  return countryName(code, displayLanguage(activeOrgLocale()))
}

/**
 * Países para elegir por su nombre (`SearchSelect`), con el de la clínica
 * primero. Sin país de la clínica, en orden alfabético.
 */
export function countryChoices(clinicCountry: string | null): Array<{ value: string; label: string }> {
  const language = displayLanguage(activeOrgLocale())
  const first = normalizeCountry(clinicCountry ?? undefined)
  const options = countryOptions(first ?? regionCountry(), undefined, language).map(({ value, label }) => ({
    value: value as string,
    label,
  }))
  if (first) return options
  const collator = new Intl.Collator(language, { sensitivity: "base" })
  return [...options].sort((a, b) => collator.compare(a.label, b.label))
}

/**
 * Estados civiles que se ofrecen en la clínica (HL7 MaritalStatus o la palabra
 * de su país, decisión 28), más el guardado si ya no se ofrece.
 */
export function maritalChoices(
  profile: ClinicalCountryProfile,
  stored?: string | null,
): Array<{ value: string; label: string }> {
  const options = profile.maritalStatuses.map((code) => ({ value: code as string, label: MARITAL_STATUS_LABELS[code] }))
  if (stored && !options.some((option) => option.value === stored))
    options.push({ value: stored, label: MARITAL_STATUS_LABELS[stored as MaritalStatus] ?? stored })
  return options
}

/** Tipos de documento que se ofrecen en la clínica, más el guardado si ya no se ofrece. */
export function documentChoices(
  profile: ClinicalCountryProfile,
  stored?: string | null,
): Array<{ value: string; label: string }> {
  const options: Array<{ value: string; label: string }> = profile.documentTypes.map((item) => ({
    value: item.code,
    label: DOC_TYPE_LABELS[item.code],
  }))
  if (stored && !options.some((option) => option.value === stored))
    options.push({ value: stored, label: DOC_TYPE_LABELS[stored as IdentityDocType] ?? stored })
  return options
}

/** Si el país emisor se elige (pasaporte, documento extranjero) o lo fija el tipo (DNI). */
export function documentCountryChosen(profile: ClinicalCountryProfile, docType: string | null | undefined): boolean {
  if (!docType) return false
  return documentTypeProfile(profile, docType)?.issuer.kind !== "fixed"
}

/**
 * En los formularios cortos (registro, reserva) el país emisor se pregunta
 * solo en el pasaporte y el documento extranjero: el DNI lo emite el Perú y el
 * documento nacional u otro, el país de la clínica (lo pone el servidor).
 */
export function asksDocumentCountry(profile: ClinicalCountryProfile, docType: string | null | undefined): boolean {
  if (!docType) return false
  const kind = documentTypeProfile(profile, docType)?.issuer.kind
  return kind === "foreign" || kind === "chosen"
}

/** «DNI 45678904 · Perú», «Documento nacional · 12.345.678-5 · Chile». */
export function documentLine(
  docType: string | null | undefined,
  docNumber: string | null | undefined,
  docCountry: string | null | undefined,
): string | null {
  if (!docNumber) return null
  const label = docType ? (DOC_TYPE_LABELS[docType as IdentityDocType] ?? docType) : null
  return [label, docNumber, countryText(docCountry)].filter(Boolean).join(" · ")
}

/**
 * Opciones del seguro: en Perú SIS, EsSalud y EPS con su tipo general, y en
 * todos los países los tipos generales. El valor es el régimen (`scheme:SIS`)
 * o el tipo general (`PRIVADO`).
 */
export function insuranceChoices(profile: ClinicalCountryProfile): Array<{ value: string; label: string }> {
  const schemes = profile.insuranceSchemes.map((scheme) => ({
    value: `scheme:${scheme.code}`,
    label: `${scheme.label} (${INSURANCE_TYPE_LABELS[scheme.type].toLowerCase()})`,
  }))
  const general = (Object.keys(INSURANCE_TYPE_LABELS) as InsuranceType[]).map((type) => ({
    value: type,
    label:
      schemes.length && (type === "PUBLICO" || type === "PRIVADO")
        ? `Otro seguro ${INSURANCE_TYPE_LABELS[type].toLowerCase()}`
        : INSURANCE_TYPE_LABELS[type],
  }))
  return [...schemes, ...general]
}

/** El valor de la lista del seguro para lo guardado. */
export function insuranceChoiceOf(type: string | null | undefined, scheme: string | null | undefined): string {
  if (scheme) return `scheme:${scheme}`
  return type ?? ""
}

/** Lo que guarda una opción de la lista del seguro: tipo general y régimen. */
export function insuranceFromChoice(
  profile: ClinicalCountryProfile,
  choice: string,
): { insuranceType: string | null; insuranceScheme: string | null } {
  if (!choice) return { insuranceType: null, insuranceScheme: null }
  if (choice.startsWith("scheme:")) {
    const scheme = insuranceScheme(profile, choice.slice(7))
    return { insuranceType: scheme?.type ?? null, insuranceScheme: scheme?.code ?? choice.slice(7) }
  }
  return { insuranceType: choice, insuranceScheme: null }
}

/** «EPS (privado)», «Privado». */
export function insuranceText(
  profile: ClinicalCountryProfile,
  type: string | null | undefined,
  scheme: string | null | undefined,
): string | null {
  const general = type ? (INSURANCE_TYPE_LABELS[type as InsuranceType] ?? type) : null
  if (scheme) {
    const label = insuranceScheme(profile, scheme)?.label ?? scheme
    return general ? `${label} (${general.toLowerCase()})` : label
  }
  return general
}

/** «Redes sociales», «Otro: por mi prima». Nulo si no lo dijo. */
export function referralText(kind: string | null | undefined, source: string | null | undefined): string | null {
  const said = source?.trim() || null
  if (!kind) return said
  const label = REFERRAL_KIND_LABELS[kind as ReferralKind] ?? kind
  return kind === "otro" && said ? `${label}: ${said}` : label
}

/** La región: de la lista del país si la tiene, o como se escribió. */
export function regionText(profile: ClinicalCountryProfile, region: string | null | undefined): string | null {
  return regionName(profile, region)
}

/**
 * La dirección en una línea: «Jr. Las Begonias 120, dpto. 302 · Miraflores,
 * Lima Metropolitana · Ref.: frente al parque» en Perú; «Av. Providencia 1234
 * · Providencia · Región Metropolitana · 7500000» en Santiago. El país solo se
 * dice si no es el de la clínica. La misma regla que la sede (`postalAddressText`).
 */
export function addressLine(
  profile: ClinicalCountryProfile,
  person: {
    address?: string | null
    addressCity?: string | null
    addressDistrict?: string | null
    addressRegion?: string | null
    addressPostalCode?: string | null
    addressCountry?: string | null
    addressReference?: string | null
  },
): string | null {
  return postalAddressText(
    profile,
    {
      line: person.address,
      city: person.addressCity,
      region: person.addressRegion,
      postalCode: person.addressPostalCode,
      country: person.addressCountry,
    },
    {
      reference: profile.address.reference ? person.addressReference : null,
      language: displayLanguage(activeOrgLocale()),
    },
  )
}
