import { withOrgContext } from "@odentia/db"
import {
  adjustLetterhead,
  assertCurrentLetterhead,
  clampLetterheadMargins,
  cleanLetterheadImage,
  clinicLogoFolder,
  getCurrentLetterhead,
  type Letterhead,
  letterheadContact,
  letterheadPdfKey,
  letterheadSampleSigner,
  loadDocumentClinic,
  normalizeLetterhead,
  removeLetterhead,
  renderLetterheadSamplePdf,
  restoreLetterhead,
  ServiceError,
  sampleCheckUrl,
  saveLetterhead,
} from "@odentia/services"
import { type Context, Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

/** La hoja de 5 MB más sus franjas y la miniatura. */
const UPLOAD_MAX_BYTES = 16 * 1024 * 1024

/** Lo que la pantalla sabe de una hoja: nunca dónde está guardado su PDF. */
function summaryOf(letterhead: Letterhead) {
  const { pdfKey: _key, ...rest } = letterhead
  return rest
}

const marginsInput = z.object({
  topMm: z.coerce.number().finite().min(0).max(300),
  bottomMm: z.coerce.number().finite().min(0).max(300),
  leftMm: z.coerce.number().finite().min(0).max(300),
  rightMm: z.coerce.number().finite().min(0).max(300),
  hasContact: z.enum(["true", "false"]).transform((value) => value === "true"),
})

const restoreInput = z.object({ id: z.uuid() }).strict()

/** La hoja que tenía a la vista quien guarda: su id, o «none» si no había. */
const currentInput = z.union([z.literal("none"), z.uuid()]).optional()

/** `current` de la petición: undefined sin él, null si no había hoja, o su id. */
function seenOf(value: unknown) {
  const seen = currentInput.safeParse(value ?? undefined)
  if (!seen.success) return seen
  return {
    success: true as const,
    data: seen.data === undefined ? undefined : seen.data === "none" ? null : seen.data,
  }
}

/** Sin hoja que leer: se dice junto al archivo. */
function chooseSheet(): ServiceError {
  return new ServiceError("VALIDATION", 400, "Elige la hoja", { file: "Elige la hoja" })
}

function fileOf(form: FormData, name: string): File | null {
  const value = form.get(name)
  return value instanceof File ? value : null
}

async function bytesOf(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer())
}

/**
 * La hoja membretada de la clínica (ADR 0181), en Configuración › Datos de la clínica.
 * La cambia quien configura la clínica (`settings.write`), como el logo.
 */
export function createLetterheadRoute(deps: Pick<CrmDeps, "db" | "storage">) {
  const app = new Hono()
  const tooLarge = (c: Context) =>
    c.json(errorBody(c, "BODY_TOO_LARGE", "La hoja no puede superar 5 MB"), 413)
  const limit = bodyLimit({ maxSize: UPLOAD_MAX_BYTES, onError: tooLarge })
  const forbiddenLetterhead = (c: Context) =>
    c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para cambiar la hoja membretada"), 403)

  /** La hoja de hoy y lo que agregaría el papel (para la casilla de dirección y teléfono). */
  app.get("/", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.read")) return forbiddenLetterhead(c)
    const data = await withOrgContext(deps.db, orgId, async (tx) => {
      const current = await getCurrentLetterhead(tx, orgId)
      return {
        letterhead: current ? summaryOf(current) : null,
        contact: await letterheadContact(tx, orgId),
      }
    })
    return c.json({ data })
  })

  /** El PDF de la hoja de hoy, para volver a abrirla en «Cambiar la hoja» sin subirla otra vez. */
  app.get("/pdf", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) return forbiddenLetterhead(c)
    const current = await withOrgContext(deps.db, orgId, (tx) => getCurrentLetterhead(tx, orgId))
    if (!current)
      return c.json(errorBody(c, "NOT_FOUND", "La clínica no tiene hoja membretada"), 404)
    if (!deps.storage.getAttachment)
      return c.json(errorBody(c, "STORAGE_UNAVAILABLE", "No se pudo leer la hoja"), 503)
    const bytes = await deps.storage.getAttachment(current.pdfKey)
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
      "Content-Type": "application/pdf",
      "Cache-Control": "private, no-store",
    })
  })

  /**
   * La vista previa: una receta de ejemplo sobre la hoja elegida (o la de hoy), con el
   * mismo kit que los papeles. No guarda nada. Devuelve además lo que la tarjeta avisa.
   */
  app.post("/preview", limit, async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) return forbiddenLetterhead(c)
    const form = await c.req.formData().catch(() => null)
    if (!form)
      return c.json(errorBody(c, "VALIDATION", "Elige la hoja", { file: "Elige la hoja" }), 400)
    const margins = marginsInput.safeParse(Object.fromEntries(form))
    if (!margins.success) return validationError(c, margins.error.issues)
    // Sin archivo, la hoja que se tenía a la vista: si otra persona la cambió o la quitó, se dice.
    const seen = seenOf(form.get("current"))
    if (!seen.success) return validationError(c, seen.error.issues)
    const file = fileOf(form, "file")
    return runService(c, 200, async () => {
      const sheet = await normalizeLetterhead(
        file ? await bytesOf(file) : await currentPdf(orgId, seen.data),
      )
      const page = { widthPt: sheet.widthPt, heightPt: sheet.heightPt }
      const clamped = clampLetterheadMargins(page, margins.data)
      const { clinic, signer, checkUrl } = await withOrgContext(deps.db, orgId, async (tx) => ({
        clinic: await loadDocumentClinic(tx, orgId, { sheet: false }),
        signer: await letterheadSampleSigner(tx, orgId, userId),
        checkUrl: await sampleCheckUrl(tx, orgId),
      }))
      const pdf = await renderLetterheadSamplePdf(
        {
          ...clinic,
          logo: null,
          sheet: { pdf: sheet.pdf, ...clamped, hasContact: margins.data.hasContact },
        },
        signer,
        checkUrl,
      )
      return {
        pdf: Buffer.from(pdf).toString("base64"),
        pages: sheet.pages,
        lowResolution: sheet.lowResolution,
        paper: paperOf(page),
        margins: clamped,
        signer: signer?.name ?? null,
      }
    })
  })

  /**
   * Guarda la hoja: una nueva (`file`) o la de hoy con otros márgenes o casilla (sin
   * `file`). Con sus franjas y su miniatura, que dibujó el navegador.
   */
  app.put("/", limit, async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) return forbiddenLetterhead(c)
    const form = await c.req.formData().catch(() => null)
    if (!form)
      return c.json(errorBody(c, "VALIDATION", "Elige la hoja", { file: "Elige la hoja" }), 400)
    const margins = marginsInput.safeParse(Object.fromEntries(form))
    if (!margins.success) return validationError(c, margins.error.issues)
    const file = fileOf(form, "file")
    const top = fileOf(form, "topBand")
    const bottom = fileOf(form, "bottomBand")
    const thumbnail = fileOf(form, "thumbnail")
    if (!top || !bottom || !thumbnail)
      return c.json(
        errorBody(c, "VALIDATION", "Vuelve a elegir la hoja", { file: "Vuelve a elegir la hoja" }),
        400,
      )
    // La hoja que quien guarda tenía a la vista: si otra persona la cambió, no se pisa.
    const seen = seenOf(form.get("current"))
    if (!seen.success) return validationError(c, seen.error.issues)
    const expected = seen.data
    return runService(c, 200, async () => {
      const folder = clinicLogoFolder(orgId)
      const put = async (image: File, field: string) =>
        (
          await deps.storage.putAvatar({
            userId: folder,
            body: Buffer.from(await cleanLetterheadImage(await bytesOf(image), field)),
            contentType: "image/png",
            ext: "png",
          })
        ).url
      const putBands = async () => {
        const [topBandUrl, bottomBandUrl, thumbnailUrl] = await Promise.all([
          put(top, "topBand"),
          put(bottom, "bottomBand"),
          put(thumbnail, "thumbnail"),
        ])
        return { topBandUrl, bottomBandUrl, thumbnailUrl }
      }
      const { hasContact, ...rest } = margins.data
      if (!file) {
        // Ajustar la de hoy: el mismo PDF, con sus franjas recortadas de nuevo.
        if (!expected) throw chooseSheet()
        const bands = await putBands()
        const adjusted = await withOrgContext(deps.db, orgId, (tx) =>
          adjustLetterhead(tx, orgId, userId, { ...rest, hasContact, ...bands }, expected),
        )
        return { letterhead: summaryOf(adjusted) }
      }
      const sheet = await normalizeLetterhead(await bytesOf(file))
      if (!deps.storage.putAttachmentAt)
        throw new ServiceError(
          "STORAGE_UNAVAILABLE",
          503,
          "No se pudo guardar la hoja. Inténtalo de nuevo.",
        )
      const pdfKey = letterheadPdfKey(orgId)
      await deps.storage.putAttachmentAt(pdfKey, sheet.pdf, "application/pdf")
      const page = { widthPt: sheet.widthPt, heightPt: sheet.heightPt }
      const bands = await putBands()
      const saved = await withOrgContext(deps.db, orgId, (tx) =>
        saveLetterhead(
          tx,
          orgId,
          userId,
          {
            pdfKey,
            ...bands,
            pageWidthPt: page.widthPt,
            pageHeightPt: page.heightPt,
            ...clampLetterheadMargins(page, rest),
            hasContact,
            fileName: (file.name || "Hoja membretada").slice(0, 200),
          },
          expected,
        ),
      )
      return { letterhead: summaryOf(saved) }
    })
  })

  /**
   * Quita la hoja: los papeles nuevos vuelven a nuestro membrete. Devuelve cuál, para
   * «Deshacer». Con `?current=<id>`, solo si es la que se tenía a la vista.
   */
  app.delete("/", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) return forbiddenLetterhead(c)
    const seen = seenOf(c.req.query("current"))
    if (!seen.success) return validationError(c, seen.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        removeLetterhead(tx, orgId, userId, seen.data ?? undefined),
      ),
    )
  })

  /** «Deshacer»: vuelve a poner la hoja recién quitada. */
  app.post("/restore", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) return forbiddenLetterhead(c)
    const parsed = restoreInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, async () => ({
      letterhead: summaryOf(
        await withOrgContext(deps.db, orgId, (tx) =>
          restoreLetterhead(tx, orgId, userId, parsed.data.id),
        ),
      ),
    }))
  })

  async function currentPdf(orgId: string, expected?: string | null): Promise<Uint8Array> {
    const current = await withOrgContext(deps.db, orgId, async (tx) => {
      await assertCurrentLetterhead(tx, orgId, expected)
      return getCurrentLetterhead(tx, orgId)
    })
    if (!current)
      throw new ServiceError("VALIDATION", 400, "Elige la hoja", { file: "Elige la hoja" })
    if (!deps.storage.getAttachment)
      throw new ServiceError(
        "STORAGE_UNAVAILABLE",
        503,
        "No se pudo leer la hoja. Inténtalo de nuevo.",
      )
    return deps.storage.getAttachment(current.pdfKey)
  }

  return app
}

/** A4, Carta u otro tamaño, por la medida de su página (1 mm de holgura). */
function paperOf(page: { widthPt: number; heightPt: number }): "A4" | "Letter" | null {
  const near = (a: number, b: number) => Math.abs(a - b) < 3
  if (near(page.widthPt, 595.28) && near(page.heightPt, 841.89)) return "A4"
  if (near(page.widthPt, 612) && near(page.heightPt, 792)) return "Letter"
  return null
}
