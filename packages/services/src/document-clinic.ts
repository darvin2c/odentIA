/**
 * La clínica en sus papeles: un solo tipo (`DocumentClinic`) y una sola función
 * que lo arma. Un ticket o una devolución conservan lo congelado al cobrar; lo
 * del papel y la impresora sale siempre del perfil de hoy.
 *
 * El logo se lee del propio almacenamiento, nunca por HTTP: solo la imagen que la
 * clínica subió a su carpeta del bucket público. Una dirección guardada a mano
 * que apunte a otro lado no se sigue (SSRF). Falla en silencio: sale con iniciales.
 */
import type { Db } from "@odentia/db"
import { organization } from "@odentia/db/schema/auth"
import { branch, orgProfile } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { branchAddressColumns, branchAddressWriter } from "./branches.js"
import type { DocumentClinic, DocumentLogo } from "./document-kit.js"
import { validation } from "./errors.js"
import type { TicketFrozen } from "./payments.js"
import { clinicLogoFolder, type Storage } from "./storage.js"

export type { DocumentClinic } from "./document-kit.js"

/** Tiempo máximo para leer el logo: un papel no espera a una imagen. */
const LOGO_TIMEOUT_MS = 1500
const LOGO_CACHE_MAX = 64
/** Lo que no se pudo leer no se vuelve a intentar enseguida. */
const LOGO_RETRY_MS = 60_000

type LogoReader = Pick<Storage, "readPublicObject">

let logoReader: LogoReader | null = null
const logoCache = new Map<string, { logo: DocumentLogo | null; until: number }>()

/** La API y el worker lo fijan al arrancar, como `configurePublicLinks`. */
export function configureDocumentLogos(reader: LogoReader | null): void {
  logoReader = reader
  logoCache.clear()
}

/** PNG o JPG por su firma, no por la extensión. Otro formato (WebP) no se embebe. */
export function logoKindOf(bytes: Uint8Array): DocumentLogo["kind"] | null {
  if (
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "png"
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg"
  return null
}

async function readLogo(orgId: string, url: string | null): Promise<DocumentLogo | null> {
  if (!url || !logoReader?.readPublicObject) return null
  const cached = logoCache.get(url)
  if (cached && (cached.logo || cached.until > Date.now())) return cached.logo
  let logo: DocumentLogo | null = null
  try {
    const bytes = await logoReader.readPublicObject(
      url,
      clinicLogoFolder(orgId),
      AbortSignal.timeout(LOGO_TIMEOUT_MS),
    )
    const kind = bytes ? logoKindOf(bytes) : null
    logo = bytes && kind ? { bytes, kind } : null
  } catch {
    logo = null
  }
  if (logoCache.size >= LOGO_CACHE_MAX) logoCache.clear()
  logoCache.set(url, { logo, until: Date.now() + LOGO_RETRY_MS })
  return logo
}

async function clinicLogoOf(tx: Db, orgId: string): Promise<DocumentLogo | null> {
  const [row] = await tx
    .select({ logo: organization.logo })
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1)
  return readLogo(orgId, row?.logo ?? null)
}

/**
 * La clínica como la dice un papel de hoy. El documento no pertenece a una sede: si
 * tiene una sola, lleva su nombre, dirección y teléfono; con varias, los de la clínica.
 */
export async function loadDocumentClinic(tx: Db, orgId: string): Promise<DocumentClinic> {
  const [profile] = await tx
    .select()
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  if (!profile)
    throw validation(
      "La organización no tiene perfil regional: configúralo antes de generar documentos",
    )
  const branches = await tx
    .select({ name: branch.name, address: branchAddressColumns, phone: branch.phone })
    .from(branch)
    .where(and(eq(branch.organizationId, orgId), eq(branch.isActive, true)))
    .limit(2)
  const only = branches.length === 1 ? branches[0]! : null
  return {
    tradeName: profile.tradeName || profile.legalName || "",
    legalName: profile.legalName || null,
    fiscalDocType: profile.fiscalDocType,
    fiscalDocNumber: profile.fiscalDocNumber,
    address:
      (only ? (await branchAddressWriter(tx, orgId))(only.address) : null) ??
      profile.fiscalAddress ??
      null,
    phone: only?.phone ?? null,
    branchName: only?.name ?? null,
    logo: await clinicLogoOf(tx, orgId),
    locale: profile.locale,
    timezone: profile.timezone,
    sheetSize: profile.sheetSize,
    receiptWidth: profile.receiptWidth,
  }
}

/**
 * La clínica de un ticket o una devolución: lo que se congeló al cobrar. Lo que no
 * se congelaba antes (documento fiscal) y el teléfono, de hoy; el papel y el logo,
 * de hoy, porque son de la impresora y de la marca, no de lo cobrado.
 */
export async function loadFrozenDocumentClinic(
  tx: Db,
  orgId: string,
  frozen: { clinic: TicketFrozen["clinic"]; branch: { id: string; name: string } | null },
): Promise<DocumentClinic> {
  const today = await loadDocumentClinic(tx, orgId)
  let phone: string | null = null
  if (frozen.branch) {
    const [row] = await tx
      .select({ phone: branch.phone })
      .from(branch)
      .where(and(eq(branch.organizationId, orgId), eq(branch.id, frozen.branch.id)))
      .limit(1)
    phone = row?.phone ?? null
  }
  const clinic = frozen.clinic
  return {
    ...today,
    tradeName: clinic.tradeName || clinic.legalName,
    legalName: clinic.legalName || null,
    fiscalDocType: clinic.fiscalDocType === undefined ? today.fiscalDocType : clinic.fiscalDocType,
    fiscalDocNumber:
      clinic.fiscalDocNumber === undefined ? today.fiscalDocNumber : clinic.fiscalDocNumber,
    address: clinic.fiscalAddress ?? today.address,
    phone,
    branchName: frozen.branch?.name ?? null,
    locale: clinic.locale,
    timezone: clinic.timezone,
  }
}
