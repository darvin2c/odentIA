/**
 * Correo que llega a soporte@ y contacto@ de cada producto (lo manda firmado
 * el worker de Cloudflare a `/api/inbound/email`). Entra una sola vez por su
 * `Message-ID`. El From de un correo se puede falsificar: el cliente se busca
 * solo si el worker verificó el remitente (`senderVerified`: DMARC, o SPF o
 * DKIM alineados con el From). Entonces, por correo exacto, en este orden: un
 * contacto, una solicitud de la web, una persona del equipo de su cuenta. Si
 * no está verificado, o en el primer lugar donde aparece hay más de un
 * cliente, no se elige: queda sin cliente y Kairós lo propone
 * (`correo_sin_cliente`) para que una persona lo asigne. Nunca se busca por
 * teléfono ni por nombre.
 *
 * Con cliente, deja una actividad «correo» que entró y sus adjuntos pasan a
 * ser documentos del cliente, solo de Administración y con borrado a los 30
 * días. Los adjuntos se guardan; nadie ni nada los abre ni los manda al modelo.
 */

import { CLINICAL_PRODUCTS } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  SAAS_INBOUND_MAILBOXES,
  type SaasInboundMatch,
  saasClient,
  saasInboundEmail,
} from "@odentia/db/schema/admin-arm"
import { saasFollowUp } from "@odentia/db/schema/saas-billing"
import { eq } from "drizzle-orm"
import { z } from "zod"
import {
  cleanFilename,
  clientFileDeleteAfter,
  registerClientFile,
  type StoredInboundAttachment,
} from "./admin-client-files.js"
import { clientByEmail } from "./admin-clients.js"
import type { AdminActor } from "./admin-core.js"
import { writeAdminAudit } from "./admin-core.js"
import { issueFields, notFound, ServiceError, validation } from "./errors.js"

const TEXT_MAX = 20_000
const SUBJECT_MAX = 998
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

const inboundSchema = z.strictObject({
  mailbox: z.enum(SAAS_INBOUND_MAILBOXES, "Buzón no válido"),
  product: z.enum(CLINICAL_PRODUCTS, "Producto no válido"),
  messageId: z.string().trim().min(1, "Falta el Message-ID").max(998, "Message-ID demasiado largo"),
  from: z.string().trim().toLowerCase().pipe(z.email("Correo del remitente no válido").max(254)),
  fromName: z.string().nullish(),
  to: z.string().trim().toLowerCase().pipe(z.email("Correo de destino no válido").max(254)),
  subject: z.string().nullish(),
  text: z.string().nullish(),
  receivedAt: z.date("Fecha de llegada no válida"),
  attachments: z
    .array(attachmentSchema)
    .max(INBOUND_ATTACHMENTS_MAX, "Demasiados adjuntos")
    .default([]),
  /** El worker verificó el remitente; sin decirlo, no se da por verificado. */
  senderVerified: z.boolean().default(false),
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

/** La actividad «correo que entró» del cliente. Sin `request_id`: no es un contacto nuestro ni mueve la fecha de volver. */
async function recordInboundActivity(
  tx: Db,
  clientId: string,
  email: { mailbox: string; subject: string | null; receivedAt: Date; attachments: number },
): Promise<void> {
  const files =
    email.attachments > 0
      ? ` (${email.attachments} adjunto${email.attachments === 1 ? "" : "s"})`
      : ""
  const body = `Escribió a ${email.mailbox}@: ${email.subject ?? "(sin asunto)"}${files}`.slice(
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
    adminOnly: false,
  })
}

/** Registra los adjuntos que aún tienen su objeto como documentos del cliente; devuelve la lista con su `fileId`. */
async function attachToClient(
  tx: Db,
  actor: AdminActor | null,
  clientId: string,
  attachments: StoredInboundAttachment[],
  receivedAt: Date,
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
        deleteAfter: clientFileDeleteAfter(from),
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
      subject,
      textBody: input.text ? input.text.slice(0, TEXT_MAX) : null,
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
    }
  }
  // Un remitente sin verificar no se liga solo: su From puede ser falso.
  const match = input.senderVerified ? await matchInboundClient(tx, input.from) : null
  let fileIds: string[] = []
  if (match) {
    const attached = await attachToClient(tx, null, match.clientId, stored, input.receivedAt, now)
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
  if (!email) throw notFound("Correo")
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
    mailbox: email.mailbox,
    subject: email.subject,
    receivedAt: email.receivedAt,
    attachments: (email.attachments as StoredInboundAttachment[]).length,
  })
  await writeAdminAudit(tx, actor, {
    action: "inbound.email_assigned",
    entityId: email.id,
    metadata: { clientId, attachments: attached.fileIds.length },
  })
  return { id: email.id, clientId, fileIds: attached.fileIds }
}
