import { withOrgContext } from "@odentia/db"
import {
  assertPersonVisible,
  createContactNote,
  createPerson,
  getLockedRecord,
  getPersonPage,
  identityPatchOf,
  listLockedRecords,
  listPeople,
  listPeopleShortcuts,
  listPersonConversations,
  listPersonNotes,
  markInvitedToReturn,
  openLockedRecord,
  PEOPLE_SHORTCUTS,
  PEOPLE_VIEWS,
  personOfPatient,
  personRecordLock,
  RECORD_OPENING_REASONS,
  ServiceError,
  selfPatientOf,
  setPersonArchived,
  takeOutOfSpam,
  unblockPerson,
  updatePersonIdentity,
  usePhoneAsWhatsApp,
} from "@odentia/services"
import { type Context, Hono } from "hono"
import { z } from "zod"
import { canAccess, canAccessAny, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { recordLockResponse } from "../lib/record-lock.js"
import { type CrmDeps, runService, serviceErrorResponse, validationError } from "./helpers.js"

const listQuery = z.object({
  ver: z.enum(PEOPLE_VIEWS).optional(),
  q: z.string().max(200).optional(),
  atajo: z.enum(PEOPLE_SHORTCUTS).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

const nameText = z.string().max(100).nullable().optional()
/** Los apellidos juntos: «De la Cruz Ríos» (ADR 0058). */
const familyText = z.string().max(200).nullable().optional()
const createInput = z
  .object({
    givenNames: nameText,
    familyName: familyText,
    phone: z.string().max(50).nullable().optional(),
    email: z.string().max(200).nullable().optional(),
  })
  .strict()

const identityInput = z
  .object({
    displayName: z.string().max(200).nullable().optional(),
    givenNames: nameText,
    familyName: familyText,
    docType: z.string().max(20).nullable().optional(),
    docNumber: z.string().max(20).nullable().optional(),
    docCountry: z.string().max(2).nullable().optional(),
    birthDate: z.string().max(10).nullable().optional(),
    sex: z.string().max(1).nullable().optional(),
    phone: z.string().max(50).nullable().optional(),
    email: z.string().max(200).nullable().optional(),
  })
  .strict()

const openInput = z
  .object({ reason: z.enum(RECORD_OPENING_REASONS), note: z.string().trim().max(500).nullish() })
  .strict()

const noteInput = z.object({ body: z.string().trim().min(1).max(4000) }).strict()

function forbidden(c: Context, message: string) {
  return c.json(errorBody(c, "FORBIDDEN", message), 403)
}

/**
 * La página de cada persona (ADR 0029). Cada bloque se pide aquí o en su
 * propia ruta con su permiso: la cabecera y la lista con `patients.read`, las
 * conversaciones con `conversations.read`, las notas con el CRM; lo clínico,
 * el plan y los cobros siguen en `/api/patients/:id/...` con los suyos. No hay
 * una ruta que lo traiga todo. Quien aún no es paciente solo existe para
 * quien lleva la relación con las personas (`assertPersonVisible`): caja y
 * odontología reciben 404 en cada bloque.
 */
export function createPeopleRoute(deps: CrmDeps) {
  const app = new Hono()
  const canOf = (c: Context) => {
    const { memberRole } = orgContextOf(c)
    return (permission: string) => canAccess(memberRole, permission)
  }

  // Historias bloqueadas (ADR 0080): solo Administración las ve y las abre.
  app.get("/locked", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.erase")) return forbidden(c, "Solo Administración ve las historias bloqueadas")
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => listLockedRecords(tx, orgId)))
  })

  app.get("/:id/lock", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.erase")) return forbidden(c, "Solo Administración abre una historia bloqueada")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        const lock = await personRecordLock(tx, orgId, userId, c.req.param("id"))
        if (!lock) throw new ServiceError("RECORD_NOT_LOCKED", 409, "Esta historia no está bloqueada")
        return getLockedRecord(tx, orgId, userId, lock.patientId)
      }),
    )
  })

  app.post("/:id/lock/open", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.erase")) return forbidden(c, "Solo Administración abre una historia bloqueada")
    const parsed = openInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        const lock = await personRecordLock(tx, orgId, userId, c.req.param("id"))
        if (!lock) throw new ServiceError("RECORD_NOT_LOCKED", 409, "Esta historia no está bloqueada")
        return openLockedRecord(tx, orgId, userId, lock.patientId, parsed.data)
      }),
    )
  })

  // El resto de la página de una persona con la historia bloqueada: 404 o 423.
  app.use("/:id/*", async (c, next) => {
    const blocked = await lockGuard(c)
    if (blocked) return blocked
    await next()
  })
  app.use("/:id", async (c, next) => {
    const blocked = await lockGuard(c)
    if (blocked) return blocked
    await next()
  })
  async function lockGuard(c: Context) {
    const id = c.req.param("id")
    if (!id || !/^[0-9a-f-]{36}$/i.test(id) || c.req.path.endsWith("/lock") || c.req.path.endsWith("/lock/open"))
      return null
    const { orgId, userId } = orgContextOf(c)
    const state = await withOrgContext(deps.db, orgId, (tx) => personRecordLock(tx, orgId, userId, id))
    return recordLockResponse(c, state, !["GET", "HEAD", "OPTIONS"].includes(c.req.method))
  }

  app.get("/", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.read"))
      return forbidden(c, "No tienes permiso para ver a las personas")
    const parsed = listQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    try {
      const { items, nextCursor, counts } = await withOrgContext(deps.db, orgId, (tx) =>
        listPeople(
          tx,
          orgId,
          {
            view: parsed.data.ver,
            q: parsed.data.q,
            atajo: parsed.data.atajo,
            cursor: parsed.data.cursor,
            limit: parsed.data.limit,
          },
          canOf(c),
        ),
      )
      return c.json({ data: items, nextCursor, counts })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  // Cuántos hay en cada atajo de «Pacientes»: aparte, para que la lista no los espere.
  app.get("/shortcuts", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.read"))
      return forbidden(c, "No tienes permiso para ver a las personas")
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => listPeopleShortcuts(tx, orgId, canOf(c))))
  })

  // Nueva persona: la registra como paciente después, en su página.
  app.post("/", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccessAny(memberRole, ["patients.write", "crm.write"]))
      return forbidden(c, "No tienes permiso para crear personas")
    const parsed = createInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => createPerson(tx, orgId, { userId }, parsed.data)),
    )
  })

  // Direcciones y enlaces que solo conocen la ficha: ¿de qué persona es?
  app.get("/by-patient/:patientId", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.read"))
      return forbidden(c, "No tienes permiso para ver a las personas")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => personOfPatient(tx, orgId, c.req.param("patientId"))),
    )
  })

  app.get("/:id", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.read"))
      return forbidden(c, "No tienes permiso para ver a las personas")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getPersonPage(tx, orgId, c.req.param("id"), canOf(c))),
    )
  })

  app.get("/:id/conversations", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "conversations.read"))
      return forbidden(c, "No tienes permiso para ver conversaciones")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        await assertPersonVisible(tx, orgId, c.req.param("id"), canOf(c))
        return listPersonConversations(tx, orgId, c.req.param("id"))
      }),
    )
  })

  /**
   * Quién puede cambiar a una persona: si es paciente, quien edita la
   * filiación (`patients.write`); si no, también quien lleva el CRM.
   */
  async function canEditPerson(c: Context): Promise<boolean> {
    const { orgId, memberRole } = orgContextOf(c)
    if (canAccess(memberRole, "patients.write")) return true
    if (!canAccess(memberRole, "crm.write")) return false
    const patientId = await withOrgContext(deps.db, orgId, (tx) =>
      selfPatientOf(tx, orgId, c.req.param("id") ?? ""),
    )
    return patientId === null
  }

  app.patch("/:id/identity", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    if (!(await canEditPerson(c)))
      return forbidden(c, "No tienes permiso para cambiar los datos de esta persona")
    const parsed = identityInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        await assertPersonVisible(tx, orgId, c.req.param("id"), canOf(c))
        await updatePersonIdentity(
          tx,
          orgId,
          { userId },
          c.req.param("id"),
          identityPatchOf(parsed.data),
        )
        return { saved: true }
      }),
    )
  })

  // «Usarlo como su WhatsApp» (decisión 23): el teléfono de su ficha pasa a ser
  // su WhatsApp por decisión de quien lo pulsa (ADR 0027), como «Escribirle».
  app.post("/:id/whatsapp", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccessAny(memberRole, ["conversations.write", "patients.write"]))
      return forbidden(c, "No tienes permiso para cambiar su WhatsApp")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        await assertPersonVisible(tx, orgId, c.req.param("id"), canOf(c))
        return usePhoneAsWhatsApp(tx, orgId, userId, c.req.param("id"))
      }),
    )
  })

  // Un solo «Archivar»: la persona y su ficha juntas.
  app.put("/:id/archived", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    if (!(await canEditPerson(c)))
      return forbidden(c, "No tienes permiso para archivar a esta persona")
    const parsed = z
      .object({ archived: z.boolean() })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        await assertPersonVisible(tx, orgId, c.req.param("id"), canOf(c))
        await setPersonArchived(tx, orgId, { userId }, c.req.param("id"), parsed.data.archived)
        return { archived: parsed.data.archived }
      }),
    )
  })

  // Desde su página (ADR 0054): sacarla de Spam y desbloquearla. Lo mismo que en la Bandeja.
  app.post("/:id/not-spam", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "conversations.write"))
      return forbidden(c, "No tienes permiso para sacar a una persona de Spam")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        await assertPersonVisible(tx, orgId, c.req.param("id"), canOf(c))
        return takeOutOfSpam(tx, orgId, { contactId: c.req.param("id"), userId })
      }),
    )
  })

  // «Ya la invité»: la invitación que se hizo por teléfono o en persona (issue 139, decisión 15).
  app.post("/:id/invited-to-return", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "crm.write"))
      return forbidden(c, "No tienes permiso para anotar una invitación")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        await assertPersonVisible(tx, orgId, c.req.param("id"), canOf(c))
        return markInvitedToReturn(tx, orgId, userId, c.req.param("id"))
      }),
    )
  })

  app.post("/:id/unblock", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "crm.write"))
      return forbidden(c, "No tienes permiso para desbloquear a una persona")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        await assertPersonVisible(tx, orgId, c.req.param("id"), canOf(c))
        await unblockPerson(tx, orgId, { contactId: c.req.param("id"), userId })
        return { ok: true }
      }),
    )
  })

  // Notas de la persona: las lee y escribe quien lleva el CRM (recepción).
  app.get("/:id/notes", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "crm.read"))
      return forbidden(c, "No tienes permiso para ver las notas")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listPersonNotes(tx, orgId, c.req.param("id"))),
    )
  })

  app.post("/:id/notes", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "crm.write"))
      return forbidden(c, "No tienes permiso para escribir notas")
    const parsed = noteInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        createContactNote(tx, orgId, c.req.param("id"), { body: parsed.data.body }, { userId }),
      ),
    )
  })

  return app
}
