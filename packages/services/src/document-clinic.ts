/**
 * La clínica en sus papeles: un solo tipo (`DocumentClinic`) y una sola función
 * que lo arma. Un ticket o una devolución conservan lo congelado al cobrar; lo
 * del papel y la impresora sale siempre del perfil de hoy.
 *
 * El logo se lee del propio almacenamiento, nunca por HTTP: solo la imagen que la
 * clínica subió a su carpeta del bucket público. Una dirección guardada a mano
 * que apunte a otro lado no se sigue (SSRF). Falla en silencio: sale con iniciales.
 *
 * La hoja membretada (ADR 0181) se lee del bucket privado: la que la clínica tenía
 * cuando el papel se emitió o se firmó (`at`), o la de hoy. Si no se puede leer, el
 * papel sale con nuestro membrete y lo dice (`sheetUnavailable`) para no guardarse así.
 */
import { brandPaperInk, dominantColors } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { organization } from "@odentia/db/schema/auth"
import { branch, orgProfile } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { PDFDocument } from "pdf-lib"
import sharp from "sharp"
import { branchAddressColumns, branchAddressWriter } from "./branches.js"
import type { DocumentClinic, DocumentLogo } from "./document-kit.js"
import { validation } from "./errors.js"
import { getCurrentLetterhead, getLetterheadAt, type Letterhead } from "./letterhead.js"
import type { TicketFrozen } from "./payments.js"
import { clinicLogoFolder, type Storage } from "./storage.js"

export type { DocumentClinic } from "./document-kit.js"

/** Tiempo máximo para leer el logo: un papel no espera a una imagen. */
const LOGO_TIMEOUT_MS = 1500
const LOGO_CACHE_MAX = 64
/** Lo que no se pudo leer no se vuelve a intentar enseguida. */
const LOGO_RETRY_MS = 60_000

type LogoReader = Pick<Storage, "readPublicObject" | "getAttachment">

let logoReader: Partial<LogoReader> | null = null
const logoCache = new Map<string, { logo: DocumentLogo | null; until: number }>()

/** Tiempo máximo para leer la hoja membretada: un papel no espera indefinidamente. */
const SHEET_TIMEOUT_MS = 4000
/** Las hojas leídas, por versión (no cambian): hasta este peso en memoria. */
const SHEET_CACHE_BYTES = 48 * 1024 * 1024
const sheetCache = new Map<string, Uint8Array>()
let sheetCacheBytes = 0
const sheetReading = new Map<string, Promise<Uint8Array | null>>()
const sheetFailedUntil = new Map<string, number>()

/** La API y el worker lo fijan al arrancar, como `configurePublicLinks`. */
export function configureDocumentLogos(reader: Partial<LogoReader> | null): void {
  logoReader = reader
  logoCache.clear()
  sheetCache.clear()
  sheetCacheBytes = 0
  sheetFailedUntil.clear()
}

/** El PDF de una versión de la hoja, del bucket privado; null si no se pudo leer a tiempo. */
async function readLetterheadPdf(letterhead: Letterhead): Promise<Uint8Array | null> {
  const cached = sheetCache.get(letterhead.id)
  if (cached) {
    // La más usada queda al final: lo primero que sale es lo que menos se usó.
    sheetCache.delete(letterhead.id)
    sheetCache.set(letterhead.id, cached)
    return cached
  }
  // Varios papeles a la vez esperan la misma lectura; lo que no se pudo leer no se
  // vuelve a intentar enseguida, como el logo.
  const failed = sheetFailedUntil.get(letterhead.id)
  if (failed && failed > Date.now()) return null
  const pending = sheetReading.get(letterhead.id)
  if (pending) return pending
  const reading = fetchLetterheadPdf(letterhead).finally(() => sheetReading.delete(letterhead.id))
  sheetReading.set(letterhead.id, reading)
  return reading
}

async function fetchLetterheadPdf(letterhead: Letterhead): Promise<Uint8Array | null> {
  const get = logoReader?.getAttachment
  if (!get) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  let bytes: Uint8Array | null = null
  try {
    bytes = await Promise.race([
      get(letterhead.pdfKey),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), SHEET_TIMEOUT_MS)
      }),
    ])
    // Se dibuja con pdf-lib: si no la lee, es como si no se hubiera podido leer.
    if (bytes) (await PDFDocument.load(bytes)).getPage(0)
  } catch {
    bytes = null
  } finally {
    if (timer) clearTimeout(timer)
  }
  if (!bytes) {
    sheetFailedUntil.set(letterhead.id, Date.now() + LOGO_RETRY_MS)
    return null
  }
  if (bytes.byteLength <= SHEET_CACHE_BYTES && !sheetCache.has(letterhead.id)) {
    sheetCache.set(letterhead.id, bytes)
    sheetCacheBytes += bytes.byteLength
    for (const [id, old] of sheetCache) {
      if (sheetCacheBytes <= SHEET_CACHE_BYTES) break
      sheetCache.delete(id)
      sheetCacheBytes -= old.byteLength
    }
  }
  return bytes
}

/** La hoja de un papel, ya leída, o que no se pudo leer. */
async function sheetOf(
  letterhead: Letterhead | null,
): Promise<Pick<DocumentClinic, "sheet" | "sheetUnavailable">> {
  if (!letterhead) return { sheet: null }
  const pdf = await readLetterheadPdf(letterhead)
  if (!pdf) return { sheet: null, sheetUnavailable: true }
  // Los márgenes, como se guardaron (ya ajustados al guardar): lo que se vuelve a armar
  // al abrirse, como un comprobante, sale igual aunque la regla cambie después.
  const { topMm, bottomMm, leftMm, rightMm, hasContact } = letterhead
  return { sheet: { pdf, topMm, bottomMm, leftMm, rightMm, hasContact } }
}

/** PNG o JPG por su firma, no por la extensión. Otro formato (WebP) se convierte antes de embeberlo. */
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

/** El logo como lo embebe el papel: PNG o JPG tal cual; otro formato, como PNG de membrete; null si no es una imagen. */
export async function logoForPaper(bytes: Uint8Array): Promise<DocumentLogo | null> {
  const kind = logoKindOf(bytes)
  if (kind) return { bytes, kind }
  try {
    const png = await sharp(bytes, { failOn: "error", limitInputPixels: 40_000_000 })
      .resize({ width: 600, height: 600, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer()
    return { bytes: new Uint8Array(png), kind: "png" }
  } catch {
    return null
  }
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
    // El papel solo embebe PNG o JPG: otro formato (WebP, SVG) se pasa a PNG para que el
    // papel lleve el mismo logo que la pantalla (ADR 0148), no las iniciales.
    logo = bytes ? await logoForPaper(bytes) : null
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
 * Los colores del logo para «De tu logo» (ADR 0162): hasta dos, del más presente al
 * menos, sin blancos, negros ni grises. Un logo en blanco y negro no da ninguno. Se
 * lee como el del papel (del propio almacenamiento) y falla en silencio: sin logo
 * legible, ninguno.
 */
export async function clinicLogoColors(tx: Db, orgId: string): Promise<string[]> {
  const logo = await clinicLogoOf(tx, orgId)
  if (!logo) return []
  try {
    const { data, info } = await sharp(logo.bytes, { failOn: "error", limitInputPixels: 40_000_000 })
      .resize({ width: 96, height: 96, fit: "inside" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    return dominantColors(data, info.channels)
  } catch {
    return []
  }
}

/**
 * La clínica como la dice un papel. El documento no pertenece a una sede: si tiene una
 * sola, lleva su nombre, dirección y teléfono; con varias, los de la clínica. Con `at`,
 * la hoja membretada es la que tenía entonces (lo emitido no cambia); sin él, la de hoy.
 */
export async function loadDocumentClinic(
  tx: Db,
  orgId: string,
  /** `sheet: false`: el papel no la usa (el ticket térmico, o trae la suya), no se lee. */
  options: { at?: Date | string | null; sheet?: boolean } = {},
): Promise<DocumentClinic> {
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
  const letterhead =
    options.sheet === false
      ? null
      : options.at
        ? await getLetterheadAt(tx, orgId, new Date(options.at))
        : await getCurrentLetterhead(tx, orgId)
  const sheet = await sheetOf(letterhead)
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
    // Con la hoja, nuestro membrete no sale: el logo no hace falta.
    logo: sheet.sheet ? null : await clinicLogoOf(tx, orgId),
    brandInk: brandPaperInk(profile.brandColor),
    ...sheet,
    locale: profile.locale,
    timezone: profile.timezone,
    sheetSize: profile.sheetSize,
    receiptWidth: profile.receiptWidth,
  }
}

/**
 * La clínica de un ticket o una devolución: lo que se congeló al cobrar. Lo que no
 * se congelaba antes (documento fiscal) y el teléfono, de hoy; el papel y el logo,
 * de hoy, porque son de la impresora y de la marca, no de lo cobrado. La hoja
 * membretada, la de cuando se cobró (`at`); con ella, el comprobante dice siempre la
 * dirección: es de quien cobra, aunque la hoja ya la traiga.
 */
export async function loadFrozenDocumentClinic(
  tx: Db,
  orgId: string,
  frozen: { clinic: TicketFrozen["clinic"]; branch: { id: string; name: string } | null },
  at?: Date | string | null,
  /** El ticket térmico no lleva la hoja: no se lee. */
  options: { sheet?: boolean } = {},
): Promise<DocumentClinic> {
  const today = await loadDocumentClinic(tx, orgId, { at, sheet: options.sheet })
  let phone: string | null = null
  let branchAddress: string | null = null
  if (frozen.branch) {
    const [row] = await tx
      .select({ phone: branch.phone, address: branchAddressColumns })
      .from(branch)
      .where(and(eq(branch.organizationId, orgId), eq(branch.id, frozen.branch.id)))
      .limit(1)
    phone = row?.phone ?? null
    branchAddress = row ? (await branchAddressWriter(tx, orgId))(row.address) : null
  }
  const clinic = frozen.clinic
  return {
    ...today,
    tradeName: clinic.tradeName || clinic.legalName,
    legalName: clinic.legalName || null,
    fiscalDocType: clinic.fiscalDocType === undefined ? today.fiscalDocType : clinic.fiscalDocType,
    fiscalDocNumber:
      clinic.fiscalDocNumber === undefined ? today.fiscalDocNumber : clinic.fiscalDocNumber,
    // La dirección fiscal; sin ella, la de la sede que cobró: el comprobante la dice siempre.
    address: clinic.fiscalAddress ?? branchAddress ?? today.address,
    phone,
    branchName: frozen.branch?.name ?? null,
    sheet: today.sheet ? { ...today.sheet, hasContact: false } : today.sheet,
    locale: clinic.locale,
    timezone: clinic.timezone,
  }
}

/** El membrete de una hoja en pantalla: el mismo del papel, con el logo por su dirección pública. */
export interface DocumentLetterhead {
  name: string
  /** «Dental Smile S.A.C. · RUC 20601234567»: la razón social solo si no es el nombre. */
  fiscalLine: string | null
  logo: string | null
  /** Con una sola sede, su nombre, dirección y teléfono, como el papel. */
  branchName: string | null
  address: string | null
  phone: string | null
  /** La línea del membrete y las iniciales, como el papel (`DocumentClinic.brandInk`); sin color, tinta. */
  brandInk: string | null
  /**
   * La hoja membretada (ADR 0181): su parte de arriba y la de abajo, de borde a borde del
   * papel en pantalla. Con `hasContact` la hoja ya dice la dirección y el teléfono.
   */
  sheet: { topBand: string; bottomBand: string; hasContact: boolean } | null
}

/**
 * El membrete de la hoja que se firma en pantalla (ADR 0148): los mismos datos que
 * `loadDocumentClinic` pone en el PDF, sin leer el logo del almacenamiento.
 */
export async function loadDocumentLetterhead(
  tx: Db,
  orgId: string,
  /** La hoja membretada de ese momento (un presupuesto ya entregado); sin él, la de hoy. */
  at?: Date | string | null,
): Promise<DocumentLetterhead> {
  const [profile] = await tx
    .select({
      tradeName: orgProfile.tradeName,
      legalName: orgProfile.legalName,
      fiscalDocType: orgProfile.fiscalDocType,
      fiscalDocNumber: orgProfile.fiscalDocNumber,
      fiscalAddress: orgProfile.fiscalAddress,
      brandColor: orgProfile.brandColor,
    })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  const [org] = await tx
    .select({ name: organization.name, logo: organization.logo })
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1)
  const branches = await tx
    .select({ name: branch.name, address: branchAddressColumns, phone: branch.phone })
    .from(branch)
    .where(and(eq(branch.organizationId, orgId), eq(branch.isActive, true)))
    .limit(2)
  const only = branches.length === 1 ? branches[0] : undefined
  const name = profile?.tradeName || profile?.legalName || org?.name || ""
  const fiscal = profile?.fiscalDocNumber
    ? [profile.fiscalDocType, profile.fiscalDocNumber].filter(Boolean).join(" ")
    : null
  const letterhead = at ? await getLetterheadAt(tx, orgId, new Date(at)) : await getCurrentLetterhead(tx, orgId)
  // Con hoja, como el papel: su diseño dice quién es; abajo, la razón social y su
  // documento, y la sede y su contacto si la hoja no los trae.
  const contact = !letterhead?.hasContact
  return {
    name,
    fiscalLine:
      [
        letterhead ? profile?.legalName || name : profile?.legalName && profile.legalName !== name ? profile.legalName : null,
        fiscal,
      ]
        .filter(Boolean)
        .join(" · ") || null,
    logo: letterhead ? null : (org?.logo ?? null),
    branchName: contact ? (only?.name ?? null) : null,
    address: contact
      ? ((only ? (await branchAddressWriter(tx, orgId))(only.address) : null) ?? profile?.fiscalAddress ?? null)
      : null,
    phone: contact ? (only?.phone ?? null) : null,
    brandInk: letterhead ? null : brandPaperInk(profile?.brandColor ?? null),
    sheet: letterhead
      ? { topBand: letterhead.topBandUrl, bottomBand: letterhead.bottomBandUrl, hasContact: letterhead.hasContact }
      : null,
  }
}

/**
 * Lo que el papel agrega bajo la hoja membretada si la hoja no trae la dirección y el
 * teléfono (la casilla de la tarjeta lo dice tal cual), y cuántas sedes tiene: con
 * varias, una dirección escrita en la hoja saldría en los papeles de todas.
 */
export async function letterheadContact(
  tx: Db,
  orgId: string,
): Promise<{ line: string | null; branches: number }> {
  const [profile] = await tx
    .select({ fiscalAddress: orgProfile.fiscalAddress })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  const branches = await tx
    .select({ name: branch.name, address: branchAddressColumns, phone: branch.phone })
    .from(branch)
    .where(and(eq(branch.organizationId, orgId), eq(branch.isActive, true)))
  const only = branches.length === 1 ? branches[0]! : null
  const address = (only ? (await branchAddressWriter(tx, orgId))(only.address) : null) ?? profile?.fiscalAddress ?? null
  // Sin dirección ni teléfono que agregar, la casilla no hace falta (el nombre de la sede solo no lo es).
  const phone = only?.phone ?? null
  const line = address || phone ? [only?.name ?? null, address, phone].filter(Boolean).join(" · ") : null
  return { line, branches: branches.length }
}
