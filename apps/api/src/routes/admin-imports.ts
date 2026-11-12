import { isClinicalProduct, productWords, type ClinicalProduct } from "@odentia/clinical"
import { type Db, withOrgContext } from "@odentia/db"
import { invitation, organization, user } from "@odentia/db/schema/auth"
import { orgProfile } from "@odentia/db/schema/org"
import { invitationTemplate } from "@odentia/mail"
import {
  applyClinicImportBatch,
  CLINIC_LOGO_MIME_EXT,
  type ClinicSetupFiles,
  type ClinicSetupPlan,
  ClinicSetupRehearsal,
  type ClinicSetupResult,
  clinicImportPlanSchema,
  clinicLogoFolder,
  clinicSetupPlanSchema,
  cleanLetterheadImage,
  letterheadPdfKey,
  measureLetterheadImage,
  normalizeLetterhead,
  planFileBytes,
  previewClinicImport,
  progressReportEmail,
  progressReportPdf,
  progressReportSchema,
  progressReportSent,
  PROGRESS_REPORT_MAX_PAGES,
  recordProgressReportSent,
  runClinicSetup,
  ServiceError,
  type AdminActor,
} from "@odentia/services"
import { eq } from "drizzle-orm"
import type { Context } from "hono"
import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import type { AppDeps } from "../app.js"
import { adminContextOf } from "../lib/admin-context.js"
import { errorBody } from "../lib/error.js"
import { runService, validationError } from "./helpers.js"

/**
 * Cargar los datos de una clínica (ADR 0104): el ensayo y la carga por tandas
 * del plan de pacientes que prepara la skill de carga, y el ensayo y la carga del
 * plan de su configuración (`clinica.json`). Solo administración (lo exige el
 * servicio), con la conexión owner y el contexto de la clínica abierto.
 */
const applyInput = z.object({ plan: clinicImportPlanSchema, from: z.number().int().min(0) }).strict()

type ImportDeps = Pick<AppDeps, "ownerDb" | "storage" | "mailer" | "webURL"> & {
  /** El panel del producto de la clínica, donde se acepta la invitación. */
  panelUrlOf?: (product: ClinicalProduct) => string
}

export function createAdminImportsRoute(deps: ImportDeps) {
  const app = new Hono()
  const tooLarge = (c: Context) =>
    c.json(errorBody(c, "BODY_TOO_LARGE", "El plan pesa más de lo que se puede cargar: divídelo en dos planes"), 413)
  // Un plan de 10 000 personas pesa unos 4 MB; uno de configuración, con su logo y su hoja en
  // base64, hasta unos 10 MB.
  const patientsLimit = bodyLimit({ maxSize: 8 * 1024 * 1024, onError: tooLarge })
  const setupLimit = bodyLimit({ maxSize: 12 * 1024 * 1024, onError: tooLarge })

  app.post("/:orgId/preview", patientsLimit, async (c) => {
    const actor = adminContextOf(c)
    const orgId = c.req.param("orgId")
    const parsed = clinicImportPlanSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.ownerDb, orgId, (tx) => previewClinicImport(tx, orgId, actor, parsed.data)))
  })

  app.post("/:orgId/apply", patientsLimit, async (c) => {
    const actor = adminContextOf(c)
    const orgId = c.req.param("orgId")
    const parsed = applyInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.ownerDb, orgId, (tx) => applyClinicImportBatch(tx, orgId, actor, parsed.data.plan, parsed.data.from)),
    )
  })

  /** El ensayo: la misma carga en una transacción que se deshace. */
  const rehearse = async (orgId: string, actor: AdminActor, plan: ClinicSetupPlan): Promise<ClinicSetupResult> => {
    try {
      await withOrgContext(deps.ownerDb, orgId, async (tx: Db) => {
        throw new ClinicSetupRehearsal(await runClinicSetup(tx, orgId, actor, plan, {}, "ensayo"))
      })
    } catch (error) {
      if (error instanceof ClinicSetupRehearsal) return error.result
      throw error
    }
    throw new Error("El ensayo no devolvió nada")
  }

  /** Sube lo que la carga necesita: el logo y la hoja (convertida a PDF, medida y con sus franjas). */
  const upload = async (orgId: string, plan: ClinicSetupPlan, needs: ClinicSetupResult["needs"]): Promise<ClinicSetupFiles> => {
    const files: ClinicSetupFiles = {}
    const logo = plan.brand?.logo
    if (needs.logo && logo) {
      const ext = CLINIC_LOGO_MIME_EXT[logo.mime]
      if (!ext) throw new ServiceError("VALIDATION", 400, "El logo debe ser PNG, JPG o WebP")
      files.logoUrl = (
        await deps.storage.putAvatar({ userId: clinicLogoFolder(orgId), body: Buffer.from(planFileBytes(logo)), contentType: logo.mime, ext })
      ).url
    }
    const sheet = plan.letterhead
    if (needs.letterhead && sheet) {
      if (!deps.storage.putAttachmentAt) throw new ServiceError("STORAGE_UNAVAILABLE", 503, "No se pudo guardar la hoja. Inténtalo de nuevo.")
      const bytes = planFileBytes(sheet.file)
      const [normalized, measured] = await Promise.all([normalizeLetterhead(bytes), measureLetterheadImage(bytes)])
      const pdfKey = letterheadPdfKey(orgId)
      await deps.storage.putAttachmentAt(pdfKey, normalized.pdf, "application/pdf")
      const put = async (image: Uint8Array, field: string) =>
        (
          await deps.storage.putAvatar({
            userId: clinicLogoFolder(orgId),
            body: Buffer.from(await cleanLetterheadImage(image, field)),
            contentType: "image/png",
            ext: "png",
          })
        ).url
      const [topBandUrl, bottomBandUrl, thumbnailUrl] = await Promise.all([
        put(measured.topBand, "topBand"),
        put(measured.bottomBand, "bottomBand"),
        put(measured.thumbnail, "thumbnail"),
      ])
      files.letterhead = {
        pdfKey,
        topBandUrl,
        bottomBandUrl,
        thumbnailUrl,
        pageWidthPt: normalized.widthPt,
        pageHeightPt: normalized.heightPt,
        ...measured.margins,
        hasContact: sheet.hasContact,
        fileName: sheet.file.name.slice(0, 200),
      }
    }
    return files
  }

  /** El correo de cada invitación del equipo, después de guardar; uno que no sale se dice, no se repite solo. */
  const sendInvitations = async (orgId: string, actor: AdminActor, invites: ClinicSetupResult["invitations"]) => {
    if (!invites.length) return []
    const [org] = await deps.ownerDb
      .select({ name: organization.name, product: orgProfile.product })
      .from(organization)
      .leftJoin(orgProfile, eq(orgProfile.organizationId, organization.id))
      .where(eq(organization.id, orgId))
      .limit(1)
    const [staff] = await deps.ownerDb.select({ name: user.name }).from(user).where(eq(user.id, actor.userId)).limit(1)
    const product: ClinicalProduct = isClinicalProduct(org?.product) ? org.product : "dental"
    const panel = deps.panelUrlOf?.(product) ?? deps.webURL
    const results: Array<{ email: string; sent: boolean }> = []
    for (const invite of invites) {
      const [row] = await deps.ownerDb.select({ expiresAt: invitation.expiresAt }).from(invitation).where(eq(invitation.id, invite.id)).limit(1)
      try {
        await deps.mailer.send({
          to: invite.email,
          ...invitationTemplate({
            organizationName: org?.name ?? "tu clínica",
            inviterName: staff?.name?.trim() || "Nuestro equipo",
            url: `${panel}/accept-invitation/${invite.id}`,
            brand: productWords(product).brand,
            expires: row ? { at: row.expiresAt, timeZone: "America/Lima" } : undefined,
          }),
        })
        results.push({ email: invite.email, sent: true })
      } catch {
        results.push({ email: invite.email, sent: false })
      }
    }
    return results
  }

  app.post("/:orgId/setup/preview", setupLimit, async (c) => {
    const actor = adminContextOf(c)
    const orgId = c.req.param("orgId")
    const parsed = clinicSetupPlanSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => rehearse(orgId, actor, parsed.data))
  })

  app.post("/:orgId/setup/apply", setupLimit, async (c) => {
    const actor = adminContextOf(c)
    const orgId = c.req.param("orgId")
    const parsed = clinicSetupPlanSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const plan = parsed.data
    return runService(c, 200, async () => {
      const { needs } = await rehearse(orgId, actor, plan)
      const files = await upload(orgId, plan, needs)
      const result = await withOrgContext(deps.ownerDb, orgId, (tx) => runClinicSetup(tx, orgId, actor, plan, files, "carga"))
      const emails = await sendInvitations(orgId, actor, result.invitations)
      return { ...result, emails }
    })
  })

  // --- El informe a la clínica: se arma aquí y sale por el correo de producción, una sola vez ---
  const reportLimit = bodyLimit({ maxSize: 512 * 1024, onError: tooLarge })
  const requireReportAdmin = (actor: AdminActor) => {
    if (actor.role !== "admin") throw new ServiceError("FORBIDDEN", 403, "Solo un administrador envía informes a una clínica")
  }

  app.post("/:orgId/report/preview", reportLimit, async (c) => {
    const actor = adminContextOf(c)
    const orgId = c.req.param("orgId")
    const parsed = progressReportSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, async () => {
      requireReportAdmin(actor)
      const { bytes, pages, content } = await progressReportPdf(parsed.data)
      if (pages > PROGRESS_REPORT_MAX_PAGES) throw new ServiceError("VALIDATION", 400, `El informe salió en ${pages} hojas: acorta las listas`)
      const mail = progressReportEmail(content)
      const sent = await withOrgContext(deps.ownerDb, orgId, (tx) => progressReportSent(tx, orgId, parsed.data.number))
      return { to: content.email, replyTo: content.replyTo, subject: mail.subject, pages, pdf: Buffer.from(bytes).toString("base64"), sent }
    })
  })

  app.post("/:orgId/report/send", reportLimit, async (c) => {
    const actor = adminContextOf(c)
    const orgId = c.req.param("orgId")
    const parsed = progressReportSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, async () => {
      requireReportAdmin(actor)
      const report = parsed.data
      const before = await withOrgContext(deps.ownerDb, orgId, (tx) => progressReportSent(tx, orgId, report.number))
      if (before) throw new ServiceError("CONFLICT", 409, `El informe N.º ${report.number} ya se envió: no se envía dos veces`)
      const { bytes, content } = await progressReportPdf(report)
      const mail = progressReportEmail(content)
      try {
        await deps.mailer.send({
          to: content.email,
          ...mail,
          attachments: [{ filename: `informe-${report.number}.pdf`, content: bytes, contentType: "application/pdf" }],
        })
      } catch {
        // Un corte a mitad no dice si salió: no se repite solo.
        throw new ServiceError("SEND_UNKNOWN", 502, "No se sabe si el correo salió: revisa en Zoho antes de volver a enviarlo")
      }
      await withOrgContext(deps.ownerDb, orgId, (tx) =>
        recordProgressReportSent(tx, actor, orgId, { number: report.number, to: content.email, subject: mail.subject }),
      )
      return { sent: true, to: content.email, subject: mail.subject }
    })
  })

  return app
}
