/**
 * Correo que llega a los buzones de cada producto (soporte@, contacto@, hola@,
 * fundadores@) o a la dirección de una persona del equipo (`persona`, por su
 * `mail_local`); lo manda firmado el worker de Cloudflare a
 * `/api/inbound/email`. Una dirección que no es de nadie no entra (404
 * `MAILBOX_UNKNOWN`: el worker la rechaza); la de una persona que ya no está
 * en el equipo entra solo si responde un correo que salió con su dirección.
 * Entra una sola vez por su `Message-ID`.
 *
 * El From de un correo se puede falsificar: el cliente se busca solo si el
 * worker verificó el remitente (`senderVerified`: DMARC, o SPF o DKIM
 * alineados con el From). Entonces, primero por el hilo (`hilo`: responde un
 * envío nuestro, por su `In-Reply-To` o `References`, y viene del mismo
 * correo al que salió) y después por correo exacto, en este orden: un
 * contacto, una solicitud de la web, una persona del equipo de su cuenta. Si
 * no está verificado, o en el primer lugar donde aparece hay más de un
 * cliente, no se elige: queda sin cliente y Kairós lo propone
 * (`correo_sin_cliente`) para que una persona lo asigne. Nunca se busca por
 * teléfono ni por nombre.
 *
 * Con cliente, deja una actividad «correo» que entró y sus adjuntos pasan a
 * ser documentos del cliente, solo de Administración. Solo lo que puede ser la
 * carga de datos (soporte@ con adjuntos, `isCargaEmail`) se borra a los 30
 * días, con su texto; lo demás se guarda. Nadie ni nada abre los adjuntos ni
 * los manda al modelo.
 */

import { CLINICAL_PRODUCTS, isClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  SAAS_INBOUND_MAILBOXES,
  type SaasInboundMailbox,
  type SaasInboundMatch,
  saasClient,
  saasClientFile,
  saasInboundEmail,
  saasOutreach,
} from "@odentia/db/schema/admin-arm"
import { adminStaff } from "@odentia/db/schema/admin-core"
import { saasFollowUp } from "@odentia/db/schema/saas-billing"
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm"
import { z } from "zod"
import {
  cleanFilename,
  clientFileDeleteAfter,
  isCargaEmail,
  registerClientFile,
  type StoredInboundAttachment,
} from "./admin-client-files.js"
import { clientByEmail, inboundMailboxWords, outreachAdminOnlySql } from "./admin-clients.js"
import type { AdminActor } from "./admin-core.js"
import { writeAdminAudit } from "./admin-core.js"
import {
  replySignature,
  replySubject,
  settleRepliesOfEmail,
  threadMessageIds,
} from "./admin-sales.js"
import { outreachSenderPreview, staffByMailLocal } from "./admin-staff-mail.js"
import { issueFields, notFound, ServiceError, validation } from "./errors.js"

const TEXT_MAX = 20_000
const SUBJECT_MAX = 998
const NOTICE_MAX = 2000
export const INBOUND_ATTACHMENTS_MAX = 20

const attachmentSchema = z.strictObject({
  filename: z.string().min(1, "Falta el nombre del adjunto").max(1000),
  contentType: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/, "Tipo de adjunto no válido"),
  size: z.number().int("Tamaño no válido").min(0, "Tamaño no válido"),
  /** Dónde lo guardó quien llama (`inboundAttachmentKey`). */
  fileKey: z
    .string()
    .regex(/^inbound\/[A-Za-z0-9_.-]{1,200}$/, "La clave del adjunto no es de un correo entrante"),
})

/** Las cabeceras del hilo se guardan recortadas: `References` puede traer cientos de ids. */
const IN_REPLY_TO_MAX = 998
const REFERENCES_MAX = 8000

const inboundSchema = z
  .strictObject({
    mailbox: z.enum(SAAS_INBOUND_MAILBOXES, "Buzón no válido"),
    /** Con `persona`: la parte local a la que escribieron (`ada.lovelace` de ada.lovelace@…). */
    localPart: z.string().trim().toLowerCase().max(64, "Dirección demasiado larga").nullish(),
    /** Cabeceras del hilo, tal como llegaron. */
    inReplyTo: z.string().nullish(),
    references: z.string().nullish(),
    product: z.enum(CLINICAL_PRODUCTS, "Producto no válido"),
    messageId: z
      .string()
      .trim()
      .min(1, "Falta el Message-ID")
      .max(998, "Message-ID demasiado largo"),
    from: z.string().trim().toLowerCase().pipe(z.email("Correo del remitente no válido").max(254)),
    fromName: z.string().nullish(),
    to: z.string().trim().toLowerCase().pipe(z.email("Correo de destino no válido").max(254)),
    subject: z.string().nullish(),
    text: z.string().nullish(),
    /**
     * La primera dirección de su Reply-To: la respuesta va ahí. Una que no es un
     * correo no rechaza el correo: se ignora y la respuesta va al remitente.
     */
    replyTo: z
      .string()
      .nullish()
      .transform((value) => {
        const clean = (value ?? "").trim().toLowerCase()
        return clean && z.email().max(254).safeParse(clean).success ? clean : null
      }),
    /** El aviso del worker (adjuntos que no se guardaron), aparte del texto. */
    notice: z.string().nullish(),
    receivedAt: z.date("Fecha de llegada no válida"),
    attachments: z
      .array(attachmentSchema)
      .max(INBOUND_ATTACHMENTS_MAX, "Demasiados adjuntos")
      .default([]),
    /** El worker verificó el remitente; sin decirlo, no se da por verificado. */
    senderVerified: z.boolean().default(false),
  })
  .refine((value) => (value.mailbox === "persona") === Boolean(value.localPart), {
    message: "La dirección de una persona va con su parte local, y solo ella",
    path: ["localPart"],
  })
export type InboundEmailInput = z.input<typeof inboundSchema>

export interface InboundEmailResult {
  id: string
  /** Ya había llegado (mismo Message-ID): no se registró otra vez. Quien llama borra lo que subió. */
  duplicate: boolean
  clientId: string | null
  matchedBy: SaasInboundMatch | null
  /** Los adjuntos que quedaron como documentos del cliente. */
  fileIds: string[]
  /** La dirección de una persona: el buzón donde le llega la copia (el worker la reenvía ahí). */
  copyTo: string | null
}

/** Las cabeceras del hilo, solo sus Message-ID, recortadas para guardarlas. */
function threadHeader(value: string | null | undefined, max: number): string | null {
  const ids = threadMessageIds(value)
  while (ids.length > 1 && ids.join(" ").length > max) ids.splice(ids.length > 2 ? 1 : 0, 1)
  const text = ids.join(" ")
  return text && text.length <= max ? text : null
}

/**
 * A quién del equipo le escribieron a `<localPart>@`: una persona activa, o
 * una que ya no está si el correo responde uno que salió con su dirección
 * (entonces sin copia: ya no es suya). Si no es de nadie, 404
 * `MAILBOX_UNKNOWN` (el worker lo rechaza sin reenviarlo).
 */
export async function inboundPersonOf(
  tx: Db,
  localPart: string,
  thread: readonly string[],
): Promise<{ userId: string; copyTo: string | null }> {
  const unknown = () =>
    new ServiceError("MAILBOX_UNKNOWN", 404, "Esa dirección no es de nadie del equipo")
  const staff = await staffByMailLocal(tx, localPart)
  if (!staff) throw unknown()
  if (!staff.active) {
    const [ours] =
      thread.length > 0
        ? await tx
            .select({ id: saasOutreach.id })
            .from(saasOutreach)
            .innerJoin(adminStaff, eq(adminStaff.userId, staff.userId))
            .where(
              and(
                inArray(saasOutreach.messageId, [...thread]),
                sql`split_part(${saasOutreach.fromAddress}, '@', 1) = ${adminStaff.mailLocal}`,
              ),
            )
            .limit(1)
        : []
    if (!ours) throw unknown()
  }
  // Lo que llega a la dirección de una persona es comercial (solo Administración): a quien ya no
  // está, o a quien es de Soporte, no se le copia.
  return {
    userId: staff.userId,
    copyTo: staff.active && staff.role === "admin" ? staff.copyTo : null,
  }
}

/**
 * El cliente de una respuesta a un envío nuestro: el del envío más reciente
 * del hilo que salió a ese mismo correo. Solo con el remitente verificado.
 */
async function clientByThread(
  tx: Db,
  from: string,
  thread: readonly string[],
): Promise<string | null> {
  if (thread.length === 0) return null
  const [row] = await tx
    .select({ clientId: saasOutreach.clientId })
    .from(saasOutreach)
    .where(
      and(
        inArray(saasOutreach.messageId, [...thread]),
        eq(saasOutreach.toAddress, from),
        isNotNull(saasOutreach.clientId),
      ),
    )
    .orderBy(desc(saasOutreach.createdAt))
    .limit(1)
  return row?.clientId ?? null
}

/** Recorta y quita lo que no se imprime al final; vacío es nulo. */
function trimTo(value: string | null | undefined, max: number): string | null {
  const clean = (value ?? "").trim()
  return clean ? clean.slice(0, max) : null
}

/**
 * El cliente de un correo exacto: contacto → solicitud → miembro de su cuenta
 * (la regla única de `clientByEmail`). Si son varios, no elige.
 */
export async function matchInboundClient(
  tx: Db,
  email: string,
): Promise<{ clientId: string; matchedBy: SaasInboundMatch } | null> {
  return clientByEmail(tx, email, { members: true })
}

/**
 * La actividad «correo que entró» del cliente. Sin `request_id`: no es un
 * contacto nuestro ni mueve la fecha de volver. Lo que no llegó a soporte@ es
 * comercial (puede hablar de precios): solo de Administración.
 */
async function recordInboundActivity(
  tx: Db,
  clientId: string,
  email: {
    mailbox: SaasInboundMailbox
    toAddress: string
    subject: string | null
    receivedAt: Date
    attachments: number
  },
): Promise<void> {
  const files =
    email.attachments > 0
      ? ` (${email.attachments} adjunto${email.attachments === 1 ? "" : "s"})`
      : ""
  const body =
    `Escribió a ${inboundMailboxWords(email)}@: ${email.subject ?? "(sin asunto)"}${files}`.slice(
      0,
      2000,
    )
  await tx.insert(saasFollowUp).values({
    clientId,
    authorUserId: null,
    body,
    kind: "correo",
    direction: "entro",
    happenedAt: email.receivedAt,
    adminOnly: email.mailbox !== "soporte",
  })
}

/** Registra los adjuntos que aún tienen su objeto como documentos del cliente; devuelve la lista con su `fileId`. */
async function attachToClient(
  tx: Db,
  actor: AdminActor | null,
  clientId: string,
  attachments: StoredInboundAttachment[],
  receivedAt: Date,
  /** Llegó a soporte@ con adjuntos: puede ser la carga, que se borra a los 30 días. */
  carga: boolean,
  now: Date,
): Promise<{ attachments: StoredInboundAttachment[]; fileIds: string[] }> {
  const fileIds: string[] = []
  const out: StoredInboundAttachment[] = []
  // El plazo corre desde que llegó (o desde ahora, si dice llegar en el futuro).
  const from = receivedAt.getTime() < now.getTime() ? receivedAt : now
  for (const attachment of attachments) {
    if (!attachment.objectKey || attachment.fileId) {
      out.push(attachment)
      continue
    }
    const file = await registerClientFile(
      tx,
      actor,
      {
        clientId,
        kind: "correo",
        filename: attachment.filename,
        objectKey: attachment.objectKey,
        contentType: attachment.contentType,
        sizeBytes: attachment.size,
        adminOnly: true,
        // Solo lo de la carga (soporte@ con adjuntos) se borra a los 30 días; lo demás se guarda.
        deleteAfter: carga ? clientFileDeleteAfter(from) : null,
        source: "correo",
      },
      now,
    )
    fileIds.push(file.id)
    out.push({ ...attachment, fileId: file.id })
  }
  return { attachments: out, fileIds }
}

/**
 * Registra un correo entrante, una vez por `messageId`. Lo llama la ruta
 * firmada, sin persona (actor nulo), después de subir los adjuntos.
 */
export async function ingestInboundEmail(
  tx: Db,
  raw: InboundEmailInput,
  now = new Date(),
): Promise<InboundEmailResult> {
  const parsed = inboundSchema.safeParse(raw)
  if (!parsed.success)
    throw validation(
      parsed.error.issues[0]?.message ?? "Correo no válido",
      issueFields(parsed.error.issues),
    )
  const input = parsed.data
  const subject = trimTo(input.subject, SUBJECT_MAX)
  const inReplyTo = threadHeader(input.inReplyTo, IN_REPLY_TO_MAX)
  const references = threadHeader(input.references, REFERENCES_MAX)
  const thread = threadMessageIds(inReplyTo, references)
  const person = input.localPart ? await inboundPersonOf(tx, input.localPart, thread) : null
  const stored: StoredInboundAttachment[] = input.attachments.map((attachment) => ({
    filename: cleanFilename(attachment.filename),
    contentType: attachment.contentType,
    size: attachment.size,
    fileId: null,
    objectKey: attachment.fileKey,
  }))
  const [created] = await tx
    .insert(saasInboundEmail)
    .values({
      mailbox: input.mailbox,
      product: input.product,
      messageId: input.messageId,
      fromAddress: input.from,
      fromName: trimTo(input.fromName, 200),
      toAddress: input.to,
      staffUserId: person?.userId ?? null,
      inReplyTo,
      references,
      replyTo: input.replyTo,
      subject,
      textBody: input.text ? input.text.slice(0, TEXT_MAX) : null,
      notice: trimTo(input.notice, NOTICE_MAX),
      senderVerified: input.senderVerified,
      receivedAt: input.receivedAt,
      attachments: stored,
    })
    .onConflictDoNothing({ target: saasInboundEmail.messageId })
    .returning({ id: saasInboundEmail.id })
  if (!created) {
    const [existing] = await tx
      .select({
        id: saasInboundEmail.id,
        clientId: saasInboundEmail.clientId,
        matchedBy: saasInboundEmail.matchedBy,
      })
      .from(saasInboundEmail)
      .where(eq(saasInboundEmail.messageId, input.messageId))
      .limit(1)
    if (!existing)
      throw new ServiceError("CONFLICT", 409, "El correo se está registrando en otra petición")
    return {
      id: existing.id,
      duplicate: true,
      clientId: existing.clientId,
      matchedBy: (existing.matchedBy as SaasInboundMatch | null) ?? null,
      fileIds: [],
      copyTo: person?.copyTo ?? null,
    }
  }
  // Un remitente sin verificar no se liga solo: su From puede ser falso. Primero el hilo.
  const threadClient = input.senderVerified ? await clientByThread(tx, input.from, thread) : null
  const match: { clientId: string; matchedBy: SaasInboundMatch } | null = threadClient
    ? { clientId: threadClient, matchedBy: "hilo" }
    : input.senderVerified
      ? await matchInboundClient(tx, input.from)
      : null
  let fileIds: string[] = []
  if (match) {
    const carga = isCargaEmail({
      mailbox: input.mailbox,
      attachments: stored.length,
      notice: input.notice,
    })
    const attached = await attachToClient(
      tx,
      null,
      match.clientId,
      stored,
      input.receivedAt,
      carga,
      now,
    )
    fileIds = attached.fileIds
    await tx
      .update(saasInboundEmail)
      .set({
        clientId: match.clientId,
        matchedBy: match.matchedBy,
        matchedAt: now,
        attachments: attached.attachments,
      })
      .where(eq(saasInboundEmail.id, created.id))
    await recordInboundActivity(tx, match.clientId, {
      mailbox: input.mailbox,
      toAddress: input.to,
      subject,
      receivedAt: input.receivedAt,
      attachments: stored.length,
    })
  }
  await writeAdminAudit(tx, null, {
    action: "inbound.email_received",
    entityId: created.id,
    metadata: {
      mailbox: input.mailbox,
      staffUserId: person?.userId ?? null,
      product: input.product,
      matchedBy: match?.matchedBy ?? null,
      clientId: match?.clientId ?? null,
      senderVerified: input.senderVerified,
      attachments: stored.length,
    },
  })
  return {
    id: created.id,
    duplicate: false,
    clientId: match?.clientId ?? null,
    matchedBy: match?.matchedBy ?? null,
    fileIds,
    copyTo: person?.copyTo ?? null,
  }
}

/**
 * Una persona dice de qué cliente es un correo que quedó sin cliente (o lo
 * aprueba desde lo que propuso Kairós). Sus adjuntos pasan a ser documentos
 * del cliente y queda la actividad. Uno ya asignado no cambia de cliente.
 */
export async function assignInboundEmail(
  tx: Db,
  actor: AdminActor | null,
  emailId: string,
  clientId: string,
  now = new Date(),
): Promise<{ id: string; clientId: string; fileIds: string[] }> {
  if (!actor) throw new ServiceError("FORBIDDEN", 403, "Se requiere personal de administración")
  if (!/^[0-9a-f-]{36}$/i.test(emailId)) throw notFound("Correo")
  const [email] = await tx
    .select()
    .from(saasInboundEmail)
    .where(eq(saasInboundEmail.id, emailId))
    .for("update")
    .limit(1)
  // Lo que no llegó a soporte@ es comercial: para Soporte no existe (como al leerlo).
  if (!email || (actor.role !== "admin" && email.mailbox !== "soporte")) throw notFound("Correo")
  if (email.clientId === clientId) return { id: email.id, clientId, fileIds: [] }
  if (email.clientId) throw new ServiceError("CONFLICT", 409, "Ese correo ya es de otro cliente")
  const [client] = await tx
    .select({ id: saasClient.id })
    .from(saasClient)
    .where(eq(saasClient.id, clientId))
    .limit(1)
  if (!client)
    throw new ServiceError("VALIDATION", 400, "Cliente no encontrado", {
      clientId: "Cliente no encontrado",
    })
  // Soporte asigna el correo, pero los adjuntos son de Administración: los registra el sistema.
  const attached = await attachToClient(
    tx,
    actor.role === "admin" ? actor : null,
    clientId,
    email.attachments as StoredInboundAttachment[],
    email.receivedAt,
    isCargaEmail({
      mailbox: email.mailbox,
      attachments: (email.attachments as StoredInboundAttachment[]).length,
      notice: email.notice,
    }),
    now,
  )
  await tx
    .update(saasInboundEmail)
    .set({
      clientId,
      matchedBy: "persona",
      matchedAt: now,
      matchedByUser: actor.userId,
      attachments: attached.attachments,
    })
    .where(eq(saasInboundEmail.id, email.id))
  await recordInboundActivity(tx, clientId, {
    mailbox: email.mailbox as SaasInboundMailbox,
    toAddress: email.toAddress,
    subject: email.subject,
    receivedAt: email.receivedAt,
    attachments: (email.attachments as StoredInboundAttachment[]).length,
  })
  // Lo que se le respondió antes de saber de quién era pasa a su cliente.
  const replies = await settleRepliesOfEmail(tx, actor, email.id, clientId, now)
  await writeAdminAudit(tx, actor, {
    action: "inbound.email_assigned",
    entityId: email.id,
    metadata: { clientId, attachments: attached.fileIds.length, replies },
  })
  return { id: email.id, clientId, fileIds: attached.fileIds }
}

/** Una respuesta que se le preparó a un correo, con su estado («¿Salió?»). */
export interface InboundEmailReply {
  id: string
  status: string
  /** La dirección que firmó. */
  from: string | null
  subject: string | null
  body: string
  createdBy: string | null
  createdAt: Date
  sentAt: Date | null
  /** Los documentos que llevó adjuntos (los que quien mira puede ver). */
  files: Array<{ id: string; filename: string }>
}

export interface InboundEmailDetail {
  id: string
  mailbox: SaasInboundMailbox
  product: string
  from: string
  fromName: string | null
  to: string
  subject: string | null
  /** Nulo si era de la carga de datos y pasaron 30 días: el texto se borra. */
  text: string | null
  /** El aviso del correo entrante (adjuntos que no se guardaron), aparte del texto; se borra con él. */
  notice: string | null
  /** A dónde iría la respuesta: su Reply-To, o el remitente. */
  replyTo: string
  receivedAt: Date
  senderVerified: boolean
  clientId: string | null
  matchedBy: SaasInboundMatch | null
  /** A quién del equipo le escribieron, si fue a su dirección. */
  staff: { userId: string; name: string } | null
  attachments: number
  /** Si quien mira puede responderlo: Soporte, solo lo de soporte@. */
  canReply: boolean
  /**
   * Quién firmaría la respuesta de quien mira («Desde»), con la misma regla
   * del envío; null si no puede responder.
   */
  replyFrom: { name: string; address: string } | null
  /** La firma que el envío agrega al final de la respuesta (`replySignature`); null si no puede responder. */
  replySignature: string | null
  /** El asunto con que saldría la respuesta («Re: …»). */
  replySubject: string
  replies: InboundEmailReply[]
}

/**
 * Un correo que llegó, para leerlo y responderlo, con sus respuestas. Soporte
 * solo ve lo que llegó a soporte@ (lo comercial puede hablar de precios): lo
 * demás no existe para él (404).
 */
export async function getInboundEmail(
  tx: Db,
  actor: AdminActor,
  emailId: string,
): Promise<InboundEmailDetail> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(emailId))
    throw notFound("Correo")
  const [email] = await tx
    .select({
      row: saasInboundEmail,
      staffName: sql<
        string | null
      >`(select u.name from "user" u where u.id = ${saasInboundEmail.staffUserId})`,
    })
    .from(saasInboundEmail)
    .where(eq(saasInboundEmail.id, emailId))
    .limit(1)
  if (!email || (actor.role !== "admin" && email.row.mailbox !== "soporte"))
    throw notFound("Correo")
  const { row } = email
  // Soporte no ve las respuestas solo de Administración (con propuesta o de un ítem de Kairós suyo).
  const replies = await tx
    .select()
    .from(saasOutreach)
    .where(
      and(
        eq(saasOutreach.inReplyToEmailId, row.id),
        actor.role === "admin" ? undefined : sql`not ${outreachAdminOnlySql(`"saas_outreach"`)}`,
      ),
    )
    .orderBy(desc(saasOutreach.createdAt))
  const replyFileIds = [...new Set(replies.flatMap((reply) => reply.fileIds))]
  const replyFileRows = replyFileIds.length
    ? await tx
        .select({ id: saasClientFile.id, filename: saasClientFile.filename })
        .from(saasClientFile)
        .where(
          and(
            inArray(saasClientFile.id, replyFileIds),
            actor.role === "admin" ? undefined : eq(saasClientFile.adminOnly, false),
          ),
        )
    : []
  const fileName = new Map(replyFileRows.map((file) => [file.id, file.filename]))
  const canReply = actor.role === "admin" || row.mailbox === "soporte"
  // La marca del cliente si ya es de uno; si no, la del buzón donde llegó (como al enviar).
  const [client] = row.clientId
    ? await tx
        .select({ product: saasClient.product })
        .from(saasClient)
        .where(eq(saasClient.id, row.clientId))
        .limit(1)
    : []
  const product = [client?.product, row.product].find(
    (value): value is (typeof CLINICAL_PRODUCTS)[number] => !!value && isClinicalProduct(value),
  )
  const sender =
    canReply && product
      ? await outreachSenderPreview(tx, actor, product, row.mailbox as SaasInboundMailbox)
      : null
  return {
    id: row.id,
    mailbox: row.mailbox as SaasInboundMailbox,
    product: row.product,
    from: row.fromAddress,
    fromName: row.fromName,
    to: row.toAddress,
    subject: row.subject,
    text: row.textBody,
    notice: row.notice,
    replyTo: row.replyTo ?? row.fromAddress,
    receivedAt: row.receivedAt,
    senderVerified: row.senderVerified,
    clientId: row.clientId,
    matchedBy: (row.matchedBy as SaasInboundMatch | null) ?? null,
    staff:
      row.staffUserId && email.staffName
        ? { userId: row.staffUserId, name: email.staffName }
        : null,
    attachments: row.attachments.length,
    canReply,
    replyFrom: sender ? { name: sender.name, address: sender.address } : null,
    replySignature: sender && product ? replySignature(sender, product) : null,
    replySubject: replySubject(row.subject),
    replies: replies.map((reply) => ({
      id: reply.id,
      status: reply.status,
      from: reply.fromAddress,
      subject: reply.subject,
      body: reply.body,
      createdBy: reply.createdBy,
      createdAt: reply.createdAt,
      sentAt: reply.sentAt,
      files: reply.fileIds.flatMap((id) => {
        const filename = fileName.get(id)
        return filename ? [{ id, filename }] : []
      }),
    })),
  }
}
