/**
 * La carga de una clínica nueva (ADR 0104), una sola para la skill y para la
 * administración: el ensayo y la carga de su configuración (`clinica.json`) y de sus
 * pacientes, y el envío del informe a la clínica. La skill la corre en el servidor de
 * producción (`cli/carga.ts`); la administración solo muestra lo que quedó (cargas e
 * informes enviados). Todo como personal de administración con su rol comprobado, con
 * la conexión owner y el contexto de la clínica abierto, y con las mismas operaciones de
 * cada pantalla.
 */
import { type ClinicalProduct, isClinicalProduct, productWords } from "@odentia/clinical"
import { type Db, withOrgContext } from "@odentia/db"
import { invitation, member, organization, user } from "@odentia/db/schema/auth"
import { orgProfile } from "@odentia/db/schema/org"
import { invitationTemplate, type Mailer } from "@odentia/mail"
import {
  type AdminActor,
  applyClinicImportBatch,
  CLINIC_IMPORT_BATCH,
  CLINIC_LOGO_MIME_EXT,
  type ClinicImportPlan,
  type ClinicSetupFiles,
  type ClinicSetupPlan,
  ClinicSetupRehearsal,
  type ClinicSetupResult,
  cleanLetterheadImage,
  clinicLogoFolder,
  finishProgressReport,
  letterheadPdfKey,
  listProgressReports,
  measureLetterheadImage,
  normalizeLetterhead,
  PROGRESS_REPORT_MAX_PAGES,
  type ProgressReportInput,
  planFileBytes,
  previewClinicImport,
  productMailDomain,
  progressReportEmail,
  progressReportPdf,
  progressReportPdfKey,
  progressReportSent,
  reserveProgressReport,
  runClinicSetup,
  ServiceError,
  type Storage,
} from "@odentia/services"
import { and, eq } from "drizzle-orm"

export interface ClinicLoadDeps {
  ownerDb: Db
  storage: Storage
  mailer: Mailer
  webURL: string
  /** El panel del producto de la clínica, donde se acepta la invitación. */
  panelUrlOf?: (product: ClinicalProduct) => string
}

function requireLoadAdmin(actor: AdminActor) {
  if (actor.role !== "admin")
    throw new ServiceError(
      "FORBIDDEN",
      403,
      "Solo un administrador carga datos o envía informes a una clínica",
    )
}

export function createClinicLoad(deps: ClinicLoadDeps) {
  /** El ensayo: la misma carga en una transacción que se deshace. */
  const rehearseSetup = async (
    orgId: string,
    actor: AdminActor,
    plan: ClinicSetupPlan,
  ): Promise<ClinicSetupResult> => {
    requireLoadAdmin(actor)
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
  const upload = async (
    orgId: string,
    plan: ClinicSetupPlan,
    needs: ClinicSetupResult["needs"],
  ): Promise<ClinicSetupFiles> => {
    const files: ClinicSetupFiles = {}
    const logo = plan.brand?.logo
    if (needs.logo && logo) {
      const ext = CLINIC_LOGO_MIME_EXT[logo.mime]
      if (!ext) throw new ServiceError("VALIDATION", 400, "El logo debe ser PNG, JPG o WebP")
      files.logoUrl = (
        await deps.storage.putAvatar({
          userId: clinicLogoFolder(orgId),
          body: Buffer.from(planFileBytes(logo)),
          contentType: logo.mime,
          ext,
        })
      ).url
    }
    const sheet = plan.letterhead
    if (needs.letterhead && sheet) {
      if (!deps.storage.putAttachmentAt)
        throw new ServiceError(
          "STORAGE_UNAVAILABLE",
          503,
          "No se pudo guardar la hoja. Inténtalo de nuevo.",
        )
      const bytes = planFileBytes(sheet.file)
      const [normalized, measured] = await Promise.all([
        normalizeLetterhead(bytes),
        measureLetterheadImage(bytes),
      ])
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
  const sendInvitations = async (
    orgId: string,
    actor: AdminActor,
    invites: ClinicSetupResult["invitations"],
  ) => {
    if (!invites.length) return []
    const [org] = await deps.ownerDb
      .select({ name: organization.name, product: orgProfile.product })
      .from(organization)
      .leftJoin(orgProfile, eq(orgProfile.organizationId, organization.id))
      .where(eq(organization.id, orgId))
      .limit(1)
    const [staff] = await deps.ownerDb
      .select({ name: user.name })
      .from(user)
      .where(eq(user.id, actor.userId))
      .limit(1)
    const product: ClinicalProduct = isClinicalProduct(org?.product) ? org.product : "dental"
    const panel = deps.panelUrlOf?.(product) ?? deps.webURL
    const results: Array<{ email: string; sent: boolean }> = []
    for (const invite of invites) {
      const [row] = await deps.ownerDb
        .select({ expiresAt: invitation.expiresAt })
        .from(invitation)
        .where(eq(invitation.id, invite.id))
        .limit(1)
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

  /** La carga: lo que hay que subir, lo sube; si la carga falla, lo subido se limpia. */
  const applySetup = async (orgId: string, actor: AdminActor, plan: ClinicSetupPlan) => {
    const { needs } = await rehearseSetup(orgId, actor, plan)
    const files = await upload(orgId, plan, needs)
    const folder = clinicLogoFolder(orgId)
    let result: ClinicSetupResult
    try {
      result = await withOrgContext(deps.ownerDb, orgId, (tx) =>
        runClinicSetup(tx, orgId, actor, plan, files, "carga"),
      )
    } catch (error) {
      const uploaded = [
        files.logoUrl,
        files.letterhead?.topBandUrl,
        files.letterhead?.bottomBandUrl,
        files.letterhead?.thumbnailUrl,
      ]
      await Promise.allSettled(
        uploaded
          .filter((url): url is string => !!url)
          .map((url) => deps.storage.deleteByUrl(url, folder)),
      )
      throw error
    }
    // El logo reemplazado se borra, como en «Logo».
    if (result.replacedLogo)
      await deps.storage.deleteByUrl(result.replacedLogo, folder).catch(() => undefined)
    const emails = await sendInvitations(orgId, actor, result.invitations)
    return { ...result, emails }
  }

  const previewPatients = (orgId: string, actor: AdminActor, plan: ClinicImportPlan) =>
    withOrgContext(deps.ownerDb, orgId, (tx) => previewClinicImport(tx, orgId, actor, plan))

  /** La carga de pacientes entera, por tandas: cada tanda es su transacción y se puede seguir sin duplicar. */
  const applyPatients = async (
    orgId: string,
    actor: AdminActor,
    plan: ClinicImportPlan,
    from = 0,
  ) => {
    const done = { creadas: 0, existentes: 0, yaCargadas: 0, errores: 0 }
    const failed: Array<{ key: string; name: string; message: string }> = []
    let next = from
    let total = 0
    do {
      const batch = await withOrgContext(deps.ownerDb, orgId, (tx) =>
        applyClinicImportBatch(tx, orgId, actor, plan, next),
      )
      for (const key of Object.keys(done) as Array<keyof typeof done>) done[key] += batch.done[key]
      failed.push(...batch.failed)
      total = batch.total
      if (batch.next === next) break
      next = batch.next
    } while (next < total)
    return { next, total, done, failed, batch: CLINIC_IMPORT_BATCH }
  }

  /** El informe va a alguien de esa clínica (su equipo o una invitación) y la respuesta, a nuestro equipo. */
  const checkReportPeople = async (
    orgId: string,
    report: { email: string; companion: { email: string } },
  ) => {
    const [org] = await deps.ownerDb
      .select({ id: organization.id, product: orgProfile.product })
      .from(organization)
      .leftJoin(orgProfile, eq(orgProfile.organizationId, organization.id))
      .where(eq(organization.id, orgId))
      .limit(1)
    if (!org) throw new ServiceError("NOT_FOUND", 404, "Clínica no encontrada")
    const email = report.email.trim().toLowerCase()
    const [joined] = await deps.ownerDb
      .select({ id: member.id })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(and(eq(member.organizationId, orgId), eq(user.email, email)))
      .limit(1)
    const [invited] = await deps.ownerDb
      .select({ id: invitation.id })
      .from(invitation)
      .where(and(eq(invitation.organizationId, orgId), eq(invitation.email, email)))
      .limit(1)
    if (!joined && !invited)
      throw new ServiceError(
        "VALIDATION",
        400,
        `${report.email} no es del equipo de esta clínica ni tiene una invitación: el informe va a alguien de la clínica`,
      )
    const product: ClinicalProduct = isClinicalProduct(org.product) ? org.product : "dental"
    const domain = productMailDomain(product)
    if (!report.companion.email.toLowerCase().endsWith(`@${domain}`))
      throw new ServiceError("VALIDATION", 400, `Quien acompaña firma con su correo de ${domain}`)
  }

  /** El PDF del informe, tal como saldría, y si ese número ya salió. */
  const previewReport = async (orgId: string, actor: AdminActor, report: ProgressReportInput) => {
    requireLoadAdmin(actor)
    await checkReportPeople(orgId, report)
    const { bytes, pages, content } = await progressReportPdf(report)
    if (pages > PROGRESS_REPORT_MAX_PAGES)
      throw new ServiceError(
        "VALIDATION",
        400,
        `El informe salió en ${pages} hojas: acorta las listas`,
      )
    const mail = progressReportEmail(content)
    const sent = await withOrgContext(deps.ownerDb, orgId, (tx) =>
      progressReportSent(tx, orgId, report.number),
    )
    return {
      to: content.email,
      replyTo: content.replyTo,
      subject: mail.subject,
      pages,
      pdf: bytes,
      sent,
    }
  }

  /**
   * Envía el informe una sola vez: primero se dice si ya salió, después se guarda el PDF tal
   * como sale y se reserva el número; lo dudoso queda registrado y no se repite solo.
   */
  const sendReport = async (orgId: string, actor: AdminActor, report: ProgressReportInput) => {
    const { pdf: bytes, to, subject, sent } = await previewReport(orgId, actor, report)
    if (sent)
      throw new ServiceError(
        "CONFLICT",
        409,
        `El informe N.º ${report.number} ya se envió o se intentó: no se envía dos veces`,
      )
    if (!deps.storage.putAttachmentAt)
      throw new ServiceError(
        "STORAGE_UNAVAILABLE",
        503,
        "No se pudo guardar el informe. Inténtalo de nuevo.",
      )
    const content = (await progressReportPdf(report)).content
    const mail = progressReportEmail(content)
    const pdfKey = progressReportPdfKey(orgId, report.number)
    await deps.storage.putAttachmentAt(pdfKey, bytes, "application/pdf")
    const sending = { number: report.number, to, subject, stage: report.stage, pdfKey }
    try {
      await withOrgContext(deps.ownerDb, orgId, (tx) =>
        reserveProgressReport(tx, actor, orgId, sending),
      )
    } catch (error) {
      await deps.storage.deleteAttachment(pdfKey).catch(() => undefined)
      throw error
    }
    try {
      await deps.mailer.send({
        to,
        ...mail,
        attachments: [
          {
            filename: `informe-${report.number}.pdf`,
            content: bytes,
            contentType: "application/pdf",
          },
        ],
      })
    } catch {
      await withOrgContext(deps.ownerDb, orgId, (tx) =>
        finishProgressReport(tx, actor, orgId, { ...sending, state: "desconocido" }),
      )
      throw new ServiceError(
        "SEND_UNKNOWN",
        502,
        "No se sabe si el correo salió: revisa en Zoho antes de volver a enviarlo",
      )
    }
    await withOrgContext(deps.ownerDb, orgId, (tx) =>
      finishProgressReport(tx, actor, orgId, { ...sending, state: "enviado" }),
    )
    return { sent: true, to, subject }
  }

  /**
   * Deja en el registro un informe que salió por otra vía (el primero de la primera clínica,
   * antes de que existiera el envío): su PDF y su fecha, sin volver a enviarlo.
   */
  const registerReport = async (
    orgId: string,
    actor: AdminActor,
    report: ProgressReportInput,
    sentAt: string,
  ) => {
    const { pdf: bytes, to, subject, sent } = await previewReport(orgId, actor, report)
    if (sent)
      throw new ServiceError(
        "CONFLICT",
        409,
        `El informe N.º ${report.number} ya está en el registro`,
      )
    if (!deps.storage.putAttachmentAt)
      throw new ServiceError("STORAGE_UNAVAILABLE", 503, "No se pudo guardar el informe.")
    const pdfKey = progressReportPdfKey(orgId, report.number)
    await deps.storage.putAttachmentAt(pdfKey, bytes, "application/pdf")
    await withOrgContext(deps.ownerDb, orgId, (tx) =>
      finishProgressReport(tx, actor, orgId, {
        number: report.number,
        to,
        subject,
        stage: report.stage,
        pdfKey,
        state: "enviado",
        sentAt,
      }),
    )
    return { registered: true, to, subject, sentAt }
  }

  const listReports = async (orgId: string, actor: AdminActor) => {
    requireLoadAdmin(actor)
    const reports = await withOrgContext(deps.ownerDb, orgId, (tx) =>
      listProgressReports(tx, orgId),
    )
    return reports.map(({ pdfKey, ...report }) => ({ ...report, hasPdf: !!pdfKey }))
  }

  /** Un enlace firmado y corto para abrir el PDF de un informe enviado. */
  const reportPdfUrl = async (orgId: string, actor: AdminActor, number: number) => {
    requireLoadAdmin(actor)
    const reports = await withOrgContext(deps.ownerDb, orgId, (tx) =>
      listProgressReports(tx, orgId),
    )
    const found = reports.find((report) => report.number === number)
    if (!found?.pdfKey)
      throw new ServiceError("NOT_FOUND", 404, "Ese informe no tiene su PDF guardado")
    return { url: await deps.storage.attachmentUrl(found.pdfKey, 300) }
  }

  return {
    rehearseSetup,
    applySetup,
    previewPatients,
    applyPatients,
    previewReport,
    sendReport,
    registerReport,
    listReports,
    reportPdfUrl,
  }
}
export type ClinicLoad = ReturnType<typeof createClinicLoad>
