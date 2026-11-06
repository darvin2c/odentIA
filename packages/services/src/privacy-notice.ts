/**
 * El aviso de privacidad de la clínica (ADR 0141): el que escribió o, si aún no tiene, el
 * sugerido con sus datos. Todo formulario que pide datos lo muestra con su casilla para aceptar,
 * también «Su enlace». Sin dependencias de otros servicios: lo usan el alta y «Su enlace».
 */
import type { Db } from "@odentia/db"
import { orgProfile, patientRegistrationConfig } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { orgProductName } from "./locale.js"

/**
 * El aviso de privacidad sugerido, con los datos de la clínica. Lo publica
 * marcado «Sin revisar»: la clínica es la responsable de lo que dice y lo
 * revisa en Configuración › Registro de pacientes. No afirma cumplir ninguna
 * ley: dice para qué se usan los datos y cómo pedir verlos o corregirlos.
 */
export interface SuggestedNoticeClinic {
  legalName: string
  tradeName: string | null
  fiscalDocNumber: string | null
  fiscalAddress?: string | null
  countryCode?: string | null
  /** El nombre del producto («odentIA», «latidIA»): donde se guardan los datos. */
  productName?: string
}

export function suggestedPrivacyNotice(clinic: SuggestedNoticeClinic): string {
  const name = clinic.tradeName?.trim() || clinic.legalName.trim()
  const who =
    clinic.legalName.trim() && clinic.legalName.trim() !== name
      ? `${name} (${clinic.legalName.trim()}${clinic.fiscalDocNumber ? `, ${clinic.fiscalDocNumber}` : ""})`
      : `${name}${clinic.fiscalDocNumber ? ` (${clinic.fiscalDocNumber})` : ""}`
  const where = clinic.fiscalAddress?.trim() ? `, con domicilio en ${clinic.fiscalAddress.trim()},` : ""
  return [
    `${who}${where} usará tus datos solo para registrarte como paciente, atenderte, recordarte tus citas y cobrarte lo atendido.`,
    `Los guarda en ${clinic.productName ?? "su sistema"} y los tratan los proveedores con que la clínica te atiende y te escribe; algunos están fuera del país.`,
    "Tu historia clínica se guarda el tiempo que pide la norma de salud; lo demás, mientras seas paciente o hasta que pidas borrarlo.",
    "No los vende ni los comparte con otros fines.",
    "Puedes pedir verlos, corregirlos o eliminarlos, o que dejen de usarse para algo, en recepción o por este mismo medio.",
    // En Perú, la ley y a quién reclamar; no afirma cumplirla.
    clinic.countryCode === "PE"
      ? "Lo regula la Ley 29733 de Protección de Datos Personales: si no te responden, puedes reclamar ante la Autoridad Nacional de Protección de Datos Personales."
      : null,
  ]
    .filter((line): line is string => line !== null)
    .join(" ")
}

/** Lo que el aviso sugerido necesita de la clínica. */
export async function noticeClinic(tx: Db, orgId: string): Promise<SuggestedNoticeClinic | null> {
  const [profile] = await tx
    .select({
      legalName: orgProfile.legalName,
      tradeName: orgProfile.tradeName,
      fiscalDocNumber: orgProfile.fiscalDocNumber,
      fiscalAddress: orgProfile.fiscalAddress,
      countryCode: orgProfile.countryCode,
    })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  return profile ? { ...profile, productName: await orgProductName(tx, orgId) } : null
}

/** El aviso que se muestra y se acepta: el de la clínica o, sin uno, el sugerido con sus datos. */
export async function privacyNoticeOf(tx: Db, orgId: string): Promise<string> {
  const [row] = await tx
    .select({ notice: patientRegistrationConfig.privacyNotice })
    .from(patientRegistrationConfig)
    .where(eq(patientRegistrationConfig.organizationId, orgId))
    .limit(1)
  if (row?.notice.trim()) return row.notice
  const clinic = await noticeClinic(tx, orgId)
  return clinic ? suggestedPrivacyNotice(clinic) : ""
}
