/**
 * La hoja membretada de la clínica (ADR 0180). Se sube una vez y va de fondo en todos
 * sus papeles en hoja; cada vez que se sube, se ajusta o se quita queda una versión, y
 * cada papel usa la que la clínica tenía cuando se emitió o se firmó (`getLetterheadAt`).
 *
 * Al subirla, el servidor la deja en un PDF de una página sin recorte ni giro, para que
 * el papel la dibuje igual siempre: un PDF toma su primera página, con su recorte y su
 * giro; una imagen va a toda la página. El navegador manda además dónde va el texto (lo
 * mide al dibujarla) y sus franjas en PNG para la hoja que se firma en pantalla.
 */
import { ATTENDING_ROLES } from "@odentia/auth/permissions"
import {
  clampLetterheadMargins,
  type LetterheadMargins,
  letterheadImagePage,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { member } from "@odentia/db/schema/auth"
import { auditEvent, clinicLetterhead } from "@odentia/db/schema/org"
import { and, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm"
import { degrees, PDFDocument } from "pdf-lib"
import sharp from "sharp"
import { notFound, ServiceError, validation } from "./errors.js"
import { requireProfessionalSignature } from "./professional-profiles.js"

/** Lo más que pesa la hoja que se sube. */
export const LETTERHEAD_MAX_BYTES = 5 * 1024 * 1024
/** Por debajo de esto, una imagen se imprime borrosa a toda la hoja. */
const LOW_DPI = 110

export { clampLetterheadMargins, type LetterheadMargins } from "@odentia/clinical"

export type LetterheadKind = "pdf" | "png" | "jpg"

export interface Letterhead extends LetterheadMargins {
  id: string
  pdfKey: string
  topBandUrl: string
  bottomBandUrl: string
  thumbnailUrl: string
  pageWidthPt: number
  pageHeightPt: number
  hasContact: boolean
  fileName: string
  createdAt: Date
}

/** PDF, PNG o JPG por su firma, no por la extensión ni por lo que dice el navegador. */
export function letterheadKindOf(bytes: Uint8Array): LetterheadKind | null {
  if (bytes.length > 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-") return "pdf"
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

export interface NormalizedLetterhead {
  pdf: Uint8Array
  widthPt: number
  heightPt: number
  /** Las páginas que traía: se usa la primera. */
  pages: number
  /** Una imagen chica para la hoja: se imprimirá borrosa. */
  lowResolution: boolean
}

/** Lo que está mal en un archivo se dice junto a él. */
function fileProblem(message: string, field = "file"): ServiceError {
  return validation(message, { [field]: message })
}

/**
 * La hoja como la dibujan los papeles: un PDF de una página, del tamaño que se ve (su
 * recorte) y ya derecha (su giro aplicado). Una imagen va a toda la página: A4 o Carta
 * si tiene su forma, si no del ancho de una A4.
 */
export async function normalizeLetterhead(bytes: Uint8Array): Promise<NormalizedLetterhead> {
  if (bytes.byteLength > LETTERHEAD_MAX_BYTES) throw fileProblem("La hoja no puede superar 5 MB")
  const kind = letterheadKindOf(bytes)
  if (!kind) throw fileProblem("La hoja debe ser PDF, PNG o JPG")
  const out = await PDFDocument.create()
  if (kind === "pdf") {
    let source: PDFDocument
    try {
      // Se abre aunque esté protegido, para decir por qué no sirve en vez de «no se pudo leer».
      source = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true })
    } catch {
      throw fileProblem("No pudimos leer ese PDF. Prueba guardándolo de nuevo como PDF")
    }
    // pdf-lib no descifra: uno protegido, aunque se abra sin clave (solo limita imprimir o
    // copiar), saldría en blanco o roto en el papel.
    if (source.isEncrypted)
      throw fileProblem(
        "Tu PDF tiene clave o está protegido: ábrelo y guárdalo de nuevo como PDF sin protección (por ejemplo, Imprimir › Guardar como PDF)",
      )
    const pages = source.getPageCount()
    if (pages === 0) throw fileProblem("Ese PDF no tiene páginas")
    const page = source.getPage(0)
    const crop = page.getCropBox()
    const rotation = (((page.getRotation().angle % 360) + 360) % 360) as 0 | 90 | 180 | 270
    const turned = rotation === 90 || rotation === 270
    const width = turned ? crop.height : crop.width
    const height = turned ? crop.width : crop.height
    if (!(width > 0 && height > 0)) throw fileProblem("No pudimos leer ese PDF")
    const embedded = await out.embedPage(page, {
      left: crop.x,
      bottom: crop.y,
      right: crop.x + crop.width,
      top: crop.y + crop.height,
    })
    const target = out.addPage([width, height])
    // El giro de la página es en el sentido del reloj; se aplica al dibujarla.
    const place =
      rotation === 90
        ? { x: 0, y: height, rotate: degrees(-90) }
        : rotation === 180
          ? { x: width, y: height, rotate: degrees(180) }
          : rotation === 270
            ? { x: width, y: 0, rotate: degrees(90) }
            : { x: 0, y: 0, rotate: degrees(0) }
    target.drawPage(embedded, { ...place, width: crop.width, height: crop.height })
    return { pdf: await out.save(), widthPt: width, heightPt: height, pages, lowResolution: false }
  }
  let image: Awaited<ReturnType<PDFDocument["embedPng"]>>
  try {
    // Derecha como la ve el navegador: una foto del celular trae su giro aparte (EXIF).
    const upright = sharp(bytes, { failOn: "error", limitInputPixels: 60_000_000 }).rotate()
    image =
      kind === "png"
        ? await out.embedPng(await upright.png().toBuffer())
        : await out.embedJpg(await upright.jpeg({ quality: 92 }).toBuffer())
  } catch {
    throw fileProblem("No pudimos leer esa imagen")
  }
  const size = letterheadImagePage(image.width, image.height)
  out
    .addPage([size.width, size.height])
    .drawImage(image, { x: 0, y: 0, width: size.width, height: size.height })
  return {
    pdf: await out.save(),
    widthPt: size.width,
    heightPt: size.height,
    pages: 1,
    lowResolution: image.width / (size.width / 72) < LOW_DPI,
  }
}

const letterheadColumns = {
  id: clinicLetterhead.id,
  pdfKey: clinicLetterhead.pdfKey,
  topBandUrl: clinicLetterhead.topBandUrl,
  bottomBandUrl: clinicLetterhead.bottomBandUrl,
  thumbnailUrl: clinicLetterhead.thumbnailUrl,
  pageWidthPt: clinicLetterhead.pageWidthPt,
  pageHeightPt: clinicLetterhead.pageHeightPt,
  topMm: clinicLetterhead.topMm,
  bottomMm: clinicLetterhead.bottomMm,
  leftMm: clinicLetterhead.leftMm,
  rightMm: clinicLetterhead.rightMm,
  hasContact: clinicLetterhead.hasContact,
  fileName: clinicLetterhead.fileName,
  createdAt: clinicLetterhead.createdAt,
}

/** La hoja vigente de la clínica, o null si no tiene. */
export async function getCurrentLetterhead(tx: Db, orgId: string): Promise<Letterhead | null> {
  const [row] = await tx
    .select(letterheadColumns)
    .from(clinicLetterhead)
    .where(and(eq(clinicLetterhead.organizationId, orgId), isNull(clinicLetterhead.removedAt)))
    .limit(1)
  return row ?? null
}

/** La hoja que la clínica tenía en ese momento: la de un papel emitido o firmado entonces. */
export async function getLetterheadAt(tx: Db, orgId: string, at: Date): Promise<Letterhead | null> {
  const [row] = await tx
    .select(letterheadColumns)
    .from(clinicLetterhead)
    .where(
      and(
        eq(clinicLetterhead.organizationId, orgId),
        lte(clinicLetterhead.createdAt, at),
        or(isNull(clinicLetterhead.removedAt), gt(clinicLetterhead.removedAt, at)),
      ),
    )
    .orderBy(desc(clinicLetterhead.createdAt))
    .limit(1)
  return row ?? null
}

/** Una versión por su id (la del odontograma firmado, o la que vuelve con «Deshacer»). */
export async function getLetterheadById(
  tx: Db,
  orgId: string,
  id: string,
): Promise<Letterhead | null> {
  const [row] = await tx
    .select(letterheadColumns)
    .from(clinicLetterhead)
    .where(and(eq(clinicLetterhead.organizationId, orgId), eq(clinicLetterhead.id, id)))
    .limit(1)
  return row ?? null
}

export type LetterheadInput = Omit<Letterhead, "id" | "createdAt">

type LetterheadAction = "org_profile.letterhead_set" | "org_profile.letterhead_adjusted"

/** Deja una versión nueva como la vigente: la anterior queda quitada a la misma hora. */
async function putVersion(
  tx: Db,
  orgId: string,
  userId: string,
  input: LetterheadInput,
  action: LetterheadAction,
): Promise<Letterhead> {
  const margins = clampLetterheadMargins(
    { widthPt: input.pageWidthPt, heightPt: input.pageHeightPt },
    input,
  )
  await tx
    .update(clinicLetterhead)
    .set({ removedAt: sql`now()`, removedBy: userId })
    .where(and(eq(clinicLetterhead.organizationId, orgId), isNull(clinicLetterhead.removedAt)))
  let row: Letterhead | undefined
  try {
    ;[row] = await tx
      .insert(clinicLetterhead)
      .values({ ...input, ...margins, organizationId: orgId, createdBy: userId })
      .returning(letterheadColumns)
  } catch (error) {
    if ((error as { code?: string }).code === "23505")
      throw new ServiceError(
        "LETTERHEAD_CHANGED",
        409,
        "Alguien cambió la hoja membretada al mismo tiempo. Vuelve a abrirla e inténtalo de nuevo.",
      )
    throw error
  }
  if (!row)
    throw new ServiceError("LETTERHEAD_NOT_SAVED", 500, "No se pudo guardar la hoja membretada")
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: userId,
    action,
    entity: "org_profile",
    entityId: orgId,
    metadata: { letterheadId: row.id, fileName: row.fileName },
  })
  return row
}

function changedMeanwhile(): ServiceError {
  return new ServiceError(
    "LETTERHEAD_CHANGED",
    409,
    "Alguien cambió la hoja membretada mientras la tenías abierta. Ciérrala y vuelve a abrirla.",
  )
}

/**
 * La hoja que quien guarda tenía a la vista (`expected`: su id, o null si no había):
 * si otra persona la cambió entretanto, no se pisa. Sin `expected`, no se comprueba.
 */
export async function assertCurrentLetterhead(
  tx: Db,
  orgId: string,
  expected: string | null | undefined,
): Promise<void> {
  if (expected === undefined) return
  const current = await getCurrentLetterhead(tx, orgId)
  if ((current?.id ?? null) !== expected) throw changedMeanwhile()
}

/** Sube una hoja nueva. */
export async function saveLetterhead(
  tx: Db,
  orgId: string,
  userId: string,
  input: LetterheadInput,
  expected?: string | null,
): Promise<Letterhead> {
  await assertCurrentLetterhead(tx, orgId, expected)
  return putVersion(tx, orgId, userId, input, "org_profile.letterhead_set")
}

/**
 * Corrige dónde va el texto o la casilla de la hoja vigente, sin volver a subirla: el
 * mismo PDF con sus franjas recortadas de nuevo.
 */
export async function adjustLetterhead(
  tx: Db,
  orgId: string,
  userId: string,
  changes: LetterheadMargins &
    Pick<Letterhead, "hasContact" | "topBandUrl" | "bottomBandUrl" | "thumbnailUrl">,
  expected?: string,
): Promise<Letterhead> {
  const current = await getCurrentLetterhead(tx, orgId)
  // Quien la tenía abierta y otra persona la quitó: lo mismo que si la hubieran cambiado.
  if (!current) throw expected === undefined ? notFound("Hoja membretada") : changedMeanwhile()
  if (expected !== undefined && current.id !== expected) throw changedMeanwhile()
  const { id: _id, createdAt: _at, ...rest } = current
  return putVersion(tx, orgId, userId, { ...rest, ...changes }, "org_profile.letterhead_adjusted")
}

/**
 * «Deshacer» después de quitarla: la vuelve a poner como una versión nueva. Si entretanto
 * pusieron otra hoja, no la pisa.
 */
export async function restoreLetterhead(
  tx: Db,
  orgId: string,
  userId: string,
  id: string,
): Promise<Letterhead> {
  const previous = await getLetterheadById(tx, orgId, id)
  if (!previous) throw notFound("Hoja membretada")
  if (await getCurrentLetterhead(tx, orgId)) throw changedMeanwhile()
  const { id: _id, createdAt: _at, ...rest } = previous
  return putVersion(tx, orgId, userId, rest, "org_profile.letterhead_set")
}

/**
 * Quita la hoja vigente: los papeles nuevos vuelven a nuestro membrete. Devuelve la
 * quitada. Con `expected`, solo si es la que quien la quita tenía a la vista.
 */
export async function removeLetterhead(
  tx: Db,
  orgId: string,
  userId: string,
  expected?: string,
): Promise<{ removedId: string | null }> {
  await assertCurrentLetterhead(tx, orgId, expected)
  const [removed] = await tx
    .update(clinicLetterhead)
    .set({ removedAt: sql`now()`, removedBy: userId })
    .where(and(eq(clinicLetterhead.organizationId, orgId), isNull(clinicLetterhead.removedAt)))
    .returning({ id: clinicLetterhead.id })
  if (removed)
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId: userId,
      action: "org_profile.letterhead_removed",
      entity: "org_profile",
      entityId: orgId,
      metadata: { letterheadId: removed.id },
    })
  return { removedId: removed?.id ?? null }
}

/** La clave privada del PDF de una hoja: dentro de la carpeta de la clínica. */
export function letterheadPdfKey(orgId: string): string {
  return `clinics/${orgId}/hoja-membretada/${crypto.randomUUID()}.pdf`
}

/**
 * Quién firma la receta de ejemplo de la vista previa: otro profesional del equipo con
 * colegiatura (la hoja la usan todos); si no hay, quien la sube; si tampoco, ninguno.
 */
export async function letterheadSampleSigner(
  tx: Db,
  orgId: string,
  userId: string,
): Promise<{ name: string; title: string | null; registration: string | null } | null> {
  const members = await tx
    .select({ userId: member.userId, role: member.role })
    .from(member)
    .where(eq(member.organizationId, orgId))
  const attending = members.filter((row) =>
    (ATTENDING_ROLES as readonly string[]).includes(row.role),
  )
  const ordered = [
    ...attending.filter((row) => row.userId !== userId),
    ...attending.filter((row) => row.userId === userId),
  ]
  for (const row of ordered) {
    try {
      return await requireProfessionalSignature(tx, orgId, row.userId)
    } catch {
      // Sin colegiatura: se prueba con el siguiente.
    }
  }
  return null
}

/** Lo más que pesa cada franja o la miniatura que manda el navegador. */
const LETTERHEAD_IMAGE_MAX_BYTES = 3 * 1024 * 1024

/**
 * Una franja o la miniatura, como se guarda en el bucket público: PNG rehecho aquí (sin
 * lo que trajera escondido el archivo), de hasta 2400 px de ancho. Lo que no es una
 * imagen se rechaza.
 */
export async function cleanLetterheadImage(bytes: Uint8Array, field: string): Promise<Uint8Array> {
  const unusable = () =>
    validation("No pudimos preparar la vista de tu hoja. Vuelve a elegirla", {
      [field]: "Imagen no válida",
    })
  if (bytes.byteLength === 0 || bytes.byteLength > LETTERHEAD_IMAGE_MAX_BYTES) throw unusable()
  try {
    const png = await sharp(bytes, { failOn: "error", limitInputPixels: 30_000_000 })
      .resize({ width: 2400, withoutEnlargement: true })
      .png()
      .toBuffer()
    return new Uint8Array(png)
  } catch {
    throw unusable()
  }
}
