/**
 * La dirección de cada persona del equipo de Sallca en los dominios de las
 * marcas (`<mail_local>@odentia32.com`, `@latidia72.com`, `@vistia20.com`) y
 * quién firma cada correo que sale de la administración.
 *
 * La base pone la dirección sola al crear la fila del equipo
 * (`admin_staff_mail_local`): la parte local de su correo si ya es de un
 * dominio nuestro, o «nombre.apellido». Administración la corrige mientras no
 * haya salido nada con ella; después queda fija (la base también lo impide).
 *
 * Quién firma: lo que llegó a soporte@, y todo lo que escribe Soporte, sale
 * desde soporte@ de la marca («Soporte · odentIA»); lo demás que escribe
 * Administración (hola@, contacto@, fundadores@, la dirección de una persona,
 * «Escribir» y las propuestas) sale con su nombre y su dirección, o desde
 * hola@ si aún no tiene dirección. Las respuestas van a la misma dirección
 * del remitente.
 */

import { type ClinicalProduct, productWords } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import type { SaasInboundMailbox } from "@odentia/db/schema/admin-arm"
import {
  adminStaff,
  STAFF_MAIL_LOCAL_PATTERN,
  STAFF_MAIL_RESERVED,
} from "@odentia/db/schema/admin-core"
import { user } from "@odentia/db/schema/auth"
import { mailBrandName } from "@odentia/mail"
import { and, eq, isNotNull, isNull, ne } from "drizzle-orm"
import { z } from "zod"
import { type AdminActor, withAdminStaffLock, writeAdminAudit } from "./admin-core.js"
import { productMailDomain } from "./clinic-progress-report.js"
import { invalidField, ServiceError } from "./errors.js"

export { STAFF_MAIL_LOCAL_PATTERN, STAFF_MAIL_RESERVED }

const LOCAL = new RegExp(STAFF_MAIL_LOCAL_PATTERN)
const RESERVED = new Set<string>(STAFF_MAIL_RESERVED)
/** Partículas que no son el apellido: «de la Cruz» es Cruz. */
const PARTICLES = new Set(["de", "del", "la", "las", "los", "y", "e"])

/** «soporte», «Ada.Lovelace » → la parte local limpia, o el motivo por el que no vale. */
export function staffMailLocalProblem(value: string): string | null {
  const local = value.trim().toLowerCase()
  if (local.length < 2 || local.length > 64) return "Entre 2 y 64 caracteres"
  if (!LOCAL.test(local))
    return "Solo letras sin tildes y números, con un punto, guion o guion bajo entre ellos"
  if (RESERVED.has(local)) return `${local}@ es un buzón de Sallca: elige otra`
  return null
}

/**
 * «Ana María Pérez López» → «Ana Pérez»: el primer nombre y el primer
 * apellido (con cuatro palabras o más, la penúltima; con dos o tres, la
 * segunda), la misma regla que pone la dirección en la base.
 */
export function staffShortName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const kept = words.filter((word) => !PARTICLES.has(word.toLowerCase()))
  if (kept.length === 0) return name.trim()
  const first = kept[0] as string
  if (kept.length >= 4) return `${first} ${kept[kept.length - 2]}`
  if (kept.length >= 2) return `${first} ${kept[1]}`
  return first
}

/** Quién firma un correo: el nombre que se ve y la dirección (que también recibe las respuestas). */
export interface MailSender {
  name: string
  address: string
  /** La persona del equipo cuya dirección firma; nulo con soporte@ u hola@. */
  staffUserId: string | null
}

/** «odentIA», «latidIA», «vistIA». */
function brandName(product: ClinicalProduct): string {
  return mailBrandName(productWords(product).brand)
}

/** soporte@ u hola@ de la marca. */
export function brandMailbox(product: ClinicalProduct, mailbox: "soporte" | "hola"): MailSender {
  const domain = productMailDomain(product)
  return mailbox === "soporte"
    ? { name: `Soporte · ${brandName(product)}`, address: `soporte@${domain}`, staffUserId: null }
    : { name: brandName(product), address: `hola@${domain}`, staffUserId: null }
}

/**
 * Quién firma lo que escribe `actor` para un cliente de `product`: soporte@ si
 * responde lo que llegó a soporte@ o si es de Soporte; si no, la persona con su dirección, o
 * hola@ si aún no tiene. La fila de la persona queda bloqueada hasta el final
 * de la transacción: nadie le cambia la dirección mientras sale con ella. Una
 * persona que ya no está activa no escribe.
 */
export async function outreachSender(
  tx: Db,
  actor: AdminActor,
  product: ClinicalProduct,
  mailbox: SaasInboundMailbox | null = null,
): Promise<MailSender> {
  return senderFor(tx, actor, product, mailbox, true)
}

/**
 * Quién firmaría lo que escribe `actor` (la misma regla de `outreachSender`),
 * para mostrar el «Desde» antes de enviar: solo lee, sin bloquear. Null si
 * la persona ya no está activa (no puede escribir).
 */
export async function outreachSenderPreview(
  tx: Db,
  actor: AdminActor,
  product: ClinicalProduct,
  mailbox: SaasInboundMailbox | null = null,
): Promise<MailSender | null> {
  try {
    return await senderFor(tx, actor, product, mailbox, false)
  } catch (error) {
    if (error instanceof ServiceError && error.code === "STAFF_INACTIVE") return null
    throw error
  }
}

async function senderFor(
  tx: Db,
  actor: AdminActor,
  product: ClinicalProduct,
  mailbox: SaasInboundMailbox | null,
  lock: boolean,
): Promise<MailSender> {
  const query = tx
    .select({ active: adminStaff.active, mailLocal: adminStaff.mailLocal })
    .from(adminStaff)
    .where(eq(adminStaff.userId, actor.userId))
  const [staff] = await (lock ? query.for("update").limit(1) : query.limit(1))
  if (!staff?.active)
    throw new ServiceError("STAFF_INACTIVE", 403, "Tu acceso al equipo ya no está activo")
  // Soporte siempre sale desde soporte@ («Escribir» incluido): su dirección no queda fija.
  if (mailbox === "soporte" || actor.role !== "admin") return brandMailbox(product, "soporte")
  if (!staff.mailLocal) return brandMailbox(product, "hola")
  const [person] = await tx
    .select({ name: user.name })
    .from(user)
    .where(eq(user.id, actor.userId))
    .limit(1)
  return {
    name: `${staffShortName(person?.name ?? "") || brandName(product)} · ${brandName(product)}`,
    address: `${staff.mailLocal}@${productMailDomain(product)}`,
    staffUserId: actor.userId,
  }
}

/**
 * El nombre que firma una dirección ya guardada en un envío: soporte@,
 * hola@ o la de una persona del equipo (por su `mail_local`).
 */
export async function senderOfAddress(
  tx: Db,
  product: ClinicalProduct,
  address: string,
): Promise<MailSender> {
  const local = address.split("@")[0] ?? ""
  if (local === "soporte") return brandMailbox(product, "soporte")
  if (local === "hola") return brandMailbox(product, "hola")
  const [staff] = await tx
    .select({ userId: adminStaff.userId, name: user.name })
    .from(adminStaff)
    .innerJoin(user, eq(user.id, adminStaff.userId))
    .where(eq(adminStaff.mailLocal, local))
    .limit(1)
  return {
    name: `${staff ? staffShortName(staff.name) : local} · ${brandName(product)}`,
    address,
    staffUserId: staff?.userId ?? null,
  }
}

/** Salió (o pudo salir) algo con la dirección de esta persona: desde ahora queda fija. */
export async function markStaffMailUsed(tx: Db, userId: string, now = new Date()): Promise<void> {
  await tx
    .update(adminStaff)
    .set({ mailFirstSentAt: now })
    .where(
      and(
        eq(adminStaff.userId, userId),
        isNull(adminStaff.mailFirstSentAt),
        isNotNull(adminStaff.mailLocal),
      ),
    )
}

/** La persona del equipo a la que le escribieron a `<local>@`, con si está activa y su copia. */
export async function staffByMailLocal(
  tx: Db,
  local: string,
): Promise<{ userId: string; active: boolean; role: string; copyTo: string | null } | null> {
  const clean = local.trim().toLowerCase().split("+")[0] ?? ""
  if (!clean || staffMailLocalProblem(clean)) return null
  const [row] = await tx
    .select({
      userId: adminStaff.userId,
      active: adminStaff.active,
      role: adminStaff.role,
      copyTo: adminStaff.mailCopyTo,
    })
    .from(adminStaff)
    .where(eq(adminStaff.mailLocal, clean))
    .limit(1)
  return row ?? null
}

const staffMailSchema = z
  .strictObject({
    mailLocal: z.string().optional(),
    copyTo: z
      .union([
        z.literal(""),
        z.string().trim().toLowerCase().pipe(z.email("Correo no válido").max(254)),
      ])
      .nullish(),
  })
  .refine((value) => value.mailLocal !== undefined || value.copyTo !== undefined, {
    message: "Di qué cambia",
  })
export type StaffMailInput = z.input<typeof staffMailSchema>

export interface StaffMail {
  userId: string
  mailLocal: string | null
  copyTo: string | null
  /** Desde cuándo salen correos con su dirección: entonces ya no cambia. */
  firstSentAt: Date | null
}

/**
 * Administración corrige la dirección de una persona (solo mientras no salió
 * nada con ella: después, 409 `MAIL_LOCAL_FIXED`) y el buzón donde le llega la
 * copia de lo que le escriben (`copyTo`; vacío, sin copia). Ese buzón tiene
 * que estar verificado en Cloudflare para que la copia llegue.
 */
export async function setStaffMail(
  ownerDb: Db,
  actor: AdminActor,
  targetUserId: string,
  raw: StaffMailInput,
): Promise<StaffMail> {
  if (actor.role !== "admin")
    throw new ServiceError(
      "FORBIDDEN",
      403,
      "Solo Administración cambia las direcciones del equipo",
    )
  const parsed = staffMailSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw invalidField(String(issue?.path[0] ?? "mailLocal"), issue?.message ?? "Dato no válido")
  }
  const input = parsed.data
  let mailLocal: string | undefined
  if (input.mailLocal !== undefined) {
    const problem = staffMailLocalProblem(input.mailLocal)
    if (problem) throw invalidField("mailLocal", problem)
    mailLocal = input.mailLocal.trim().toLowerCase()
  }
  return withAdminStaffLock(ownerDb, async (tx) => {
    const [target] = await tx
      .select({
        mailLocal: adminStaff.mailLocal,
        copyTo: adminStaff.mailCopyTo,
        firstSentAt: adminStaff.mailFirstSentAt,
      })
      .from(adminStaff)
      .where(eq(adminStaff.userId, targetUserId))
      .for("update")
      .limit(1)
    if (!target) throw new ServiceError("NOT_FOUND", 404, "Personal no encontrado")
    const patch: { mailLocal?: string; mailCopyTo?: string | null } = {}
    if (mailLocal !== undefined && mailLocal !== target.mailLocal) {
      if (target.firstSentAt)
        throw new ServiceError(
          "MAIL_LOCAL_FIXED",
          409,
          `Ya salieron correos desde ${target.mailLocal}@: las clínicas responden ahí, así que no cambia`,
        )
      const [taken] = await tx
        .select({ userId: adminStaff.userId })
        .from(adminStaff)
        .where(and(eq(adminStaff.mailLocal, mailLocal), ne(adminStaff.userId, targetUserId)))
        .limit(1)
      if (taken) {
        // El mismo texto junto al campo y como mensaje: el formulario no lo repite abajo.
        const message = `${mailLocal}@ ya es de otra persona del equipo`
        throw new ServiceError("MAIL_LOCAL_TAKEN", 409, message, { mailLocal: message })
      }
      patch.mailLocal = mailLocal
    }
    if (input.copyTo !== undefined) {
      const copyTo = input.copyTo || null
      if (copyTo !== target.copyTo) patch.mailCopyTo = copyTo
    }
    if (Object.keys(patch).length > 0) {
      await tx.update(adminStaff).set(patch).where(eq(adminStaff.userId, targetUserId))
      await writeAdminAudit(tx, actor, {
        action: "staff.mail",
        entityId: targetUserId,
        metadata: {
          ...(patch.mailLocal ? { from: target.mailLocal, to: patch.mailLocal } : {}),
          ...(patch.mailCopyTo !== undefined ? { copy: patch.mailCopyTo !== null } : {}),
        },
      })
    }
    return {
      userId: targetUserId,
      mailLocal: patch.mailLocal ?? target.mailLocal,
      copyTo: patch.mailCopyTo !== undefined ? patch.mailCopyTo : target.copyTo,
      firstSentAt: target.firstSentAt,
    }
  })
}
