/**
 * La clínica en sus papeles: un solo tipo (`DocumentClinic`) y una sola función
 * que lo arma. Un ticket o una devolución conservan lo congelado al cobrar; lo
 * del papel y la impresora sale siempre del perfil de hoy.
 *
 * El logo se lee del propio almacenamiento, nunca por HTTP: solo la imagen que la
 * clínica subió a su carpeta del bucket público. Una dirección guardada a mano
 * que apunte a otro lado no se sigue (SSRF). Falla en silencio: sale con iniciales.
 */
import { brandPalette } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { organization } from "@odentia/db/schema/auth"
import { branch, orgProfile } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import sharp from "sharp"
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
 * Los colores del logo para «De tu logo» (ADR 0157): hasta dos, del más presente al
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

/** Agrupa los píxeles con color en cajas de 16 tonos por canal y devuelve el promedio de las más llenas. */
export function dominantColors(pixels: Uint8Array, channels: number): string[] {
  const boxes = new Map<number, { count: number; r: number; g: number; b: number }>()
  let colored = 0
  for (let i = 0; i + 3 < pixels.length; i += channels) {
    const r = pixels[i] ?? 0
    const g = pixels[i + 1] ?? 0
    const b = pixels[i + 2] ?? 0
    const alpha = channels >= 4 ? (pixels[i + 3] ?? 0) : 255
    if (alpha < 128) continue
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    // Blanco, negro y grises no son el color de una marca.
    if (max - min < 40 || max < 40) continue
    colored++
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    const box = boxes.get(key) ?? { count: 0, r: 0, g: 0, b: 0 }
    box.count++
    box.r += r
    box.g += g
    box.b += b
    boxes.set(key, box)
  }
  const ranked = [...boxes.values()]
    .filter((box) => box.count >= Math.max(4, colored * 0.03))
    .sort((a, b) => b.count - a.count)
    .map((box) => [box.r / box.count, box.g / box.count, box.b / box.count] as const)
  const chosen: Array<readonly [number, number, number]> = []
  for (const color of ranked) {
    // El segundo tiene que verse distinto del primero, no ser el mismo con otra luz.
    if (chosen.every((other) => Math.hypot(color[0] - other[0], color[1] - other[1], color[2] - other[2]) > 80))
      chosen.push(color)
    if (chosen.length === 2) break
  }
  return chosen.map((color) => `#${color.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`)
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
    brandInk: profile.brandColor ? brandPalette(profile.brandColor).paper : null,
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
}

/**
 * El membrete de la hoja que se firma en pantalla (ADR 0148): los mismos datos que
 * `loadDocumentClinic` pone en el PDF, sin leer el logo del almacenamiento.
 */
export async function loadDocumentLetterhead(tx: Db, orgId: string): Promise<DocumentLetterhead> {
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
  return {
    name,
    fiscalLine:
      [profile?.legalName && profile.legalName !== name ? profile.legalName : null, fiscal].filter(Boolean).join(" · ") ||
      null,
    logo: org?.logo ?? null,
    branchName: only?.name ?? null,
    address: (only ? (await branchAddressWriter(tx, orgId))(only.address) : null) ?? profile?.fiscalAddress ?? null,
    phone: only?.phone ?? null,
    brandInk: profile?.brandColor ? brandPalette(profile.brandColor).paper : null,
  }
}
