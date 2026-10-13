import { asAdminDecider, createAdminDecisionModel, type PlatformDecisions, type PlatformLlm } from "@odentia/agent"
import { withOrgContext } from "@odentia/db"
import {
  ADMIN_MODEL_DOWN,
  adminLineOf,
  applyAdminDraft,
  decidePendingApprovals,
  deleteAdminLine,
  discardAdminDraft,
  type AdminInterpretation,
  interpretAdminRequest,
  keywordAdminDecider,
  saveAdminDraft,
  setAdminDraftNote,
  getAdminLine,
  getAdminOverview,
  getAdminPage,
  getAdminRecommendation,
  getAdminRecommendations,
  getAdminUnreached,
  getMessagePermissions,
  listAdminLinePeople,
  listPendingApprovals,
  runAdminLineOnce,
  setConsent,
  updateAdminLine,
  updateAdminSettings,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, canAccessAny, orgContextOf, type Permission } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

const hour = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

const settingsInput = z.object({
  enabled: z.boolean().optional(),
  quietStart: hour.optional(),
  quietEnd: hour.optional(),
})

const lineInput = z.object({
  enabled: z.boolean().optional(),
  agentPart: z.boolean().optional(),
  teamPart: z.boolean().optional(),
  days: z.number().int().min(1).max(365).nullable().optional(),
  hoursBefore: z.array(z.number().int().min(1).max(168)).min(1).max(3).optional(),
  delayHours: z.number().int().min(1).max(72).nullable().optional(),
  hour: z.number().int().min(0).max(23).nullable().optional(),
  taskNote: z.string().max(400).nullable().optional(),
  noRecommend: z.boolean().optional(),
})

const draftNoteInput = z.object({ taskNote: z.string().max(400) })

const requestInput = z.object({ text: z.string().trim().min(4).max(600) })

export interface AgentAdminDeps extends CrmDeps {
  llm: PlatformLlm
  decisions?: PlatformDecisions | undefined
}

const peopleQuery = z.object({
  only: z.enum(["no-pudo"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

/** Lo que una persona del equipo registra en la ficha: qué aceptó y cómo lo dijo. */
const permissionInput = z.object({
  purpose: z.enum(["recordatorio", "seguimiento"]),
  granted: z.boolean(),
  source: z.enum(["presencial", "conversacion"]),
})

/**
 * Administrador: su página (las líneas), lo que recomienda y lo que pasó con
 * cada persona. Todo sale de consultas a la base, filtradas por los permisos
 * de quien lee: cada línea exige el del dominio de sus casos.
 *
 * Ver su página es `agent.read`. Prender, apagar o ajustar una línea, cambiar
 * el horario de silencio y pedir que no recomiende algo es administrar el
 * agente (`agent.write`). «Solo esta vez» lo pide quien puede crear las tareas
 * o decidir por el agente. Aprobar lo que espera es de quien decide por el
 * agente (`agent.decide`).
 */
export function createAgentAdminRoute(deps: AgentAdminDeps) {
  const app = new Hono()
  const canOf = (role: string) => (permission: string) => canAccess(role, permission as Permission)

  app.get("/", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return c.json(errorBody(c, "FORBIDDEN", "Sin acceso al agente"), 403)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getAdminPage(tx, orgId, canOf(memberRole))))
  })

  /** Lo suyo para «Resumen» del agente: cuántas tiene prendidas y cuántas más recomienda. */
  app.get("/overview", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return c.json(errorBody(c, "FORBIDDEN", "Sin acceso al agente"), 403)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getAdminOverview(tx, orgId, canOf(memberRole))))
  })

  app.put("/settings", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    const parsed = settingsInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => updateAdminSettings(tx, orgId, userId, parsed.data)))
  })

  // Lo que recomienda: lo lee cualquiera, y cada quien recibe solo lo que su rol puede ver.
  app.get("/recommendations", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const all = c.req.query("all") === "1"
    // La vista previa (lo que recomendaría aunque esté apagado) es para decidir si se enciende.
    const preview = c.req.query("preview") === "1"
    if (preview && !canAccess(memberRole, "agent.write")) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getAdminRecommendations(tx, orgId, canOf(memberRole), { all, preview })),
    )
  })

  app.get("/recommendations/:key", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getAdminRecommendation(tx, orgId, canOf(memberRole), c.req.param("key"))),
    )
  })

  /** «Solo esta vez»: atiende los casos de hoy sin prender la línea. */
  app.post("/recommendations/:key/once", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    const key = c.req.param("key")
    // Si el agente escribe, lo pide quien decide por él; si quedan tareas, quien puede crearlas.
    const needed: Permission = adminLineOf(key)?.agent ? "agent.decide" : "tasks.write"
    if (!canAccess(memberRole, needed)) return c.json(errorBody(c, "FORBIDDEN", "Tu rol no puede pedir esto"), 403)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        runAdminLineOnce(tx, orgId, userId, canOf(memberRole), key, { secretsKey: deps.secretsKey }),
      ),
    )
  })

  /** Las personas a las que el agente no pudo escribir hoy, con cómo habilitar a cada una. */
  app.get("/unreached", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return c.json(errorBody(c, "FORBIDDEN", "Sin acceso al agente"), 403)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getAdminUnreached(tx, orgId, canOf(memberRole))))
  })

  app.get("/lines/:key", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return c.json(errorBody(c, "FORBIDDEN", "Sin acceso al agente"), 403)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getAdminLine(tx, orgId, canOf(memberRole), c.req.param("key"))),
    )
  })

  app.patch("/lines/:key", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    const parsed = lineInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        updateAdminLine(tx, orgId, userId, canOf(memberRole), c.req.param("key"), parsed.data),
      ),
    )
  })

  /**
   * Pedirle algo con palabras. El modelo solo entiende el pedido (línea e
   * intención, entre opciones cerradas) y recibe nada más que ese texto. Lo
   * entendido queda como borrador en su línea: no prende ni cambia nada. Si el
   * modelo no responde se dice, y lo prendido sigue funcionando.
   */
  app.post("/request", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    const parsed = requestInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, async () => {
      let understood: AdminInterpretation
      try {
        const model = await createAdminDecisionModel(deps.db, { secretsKey: deps.secretsKey, platform: deps.llm, decisions: deps.decisions }, orgId)
        // Con el modelo de demostración responde el doble determinista de los servicios.
        understood = await interpretAdminRequest(parsed.data.text, model ? asAdminDecider(model) : keywordAdminDecider())
      } catch {
        return { understood: false, key: null, draft: false, message: ADMIN_MODEL_DOWN, confirmDelete: false, model: null, usage: null, unavailable: true }
      }
      const result = await withOrgContext(deps.db, orgId, (tx) => saveAdminDraft(tx, orgId, userId, parsed.data.text, understood))
      return { ...result, unavailable: false }
    })
  })

  /** Prender o guardar lo que dice el borrador: la misma operación de los interruptores. */
  app.post("/lines/:key/draft", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    const key = c.req.param("key")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        await applyAdminDraft(tx, orgId, userId, key)
        return getAdminLine(tx, orgId, canOf(memberRole), key)
      }),
    )
  })

  /** «Ponlo en la tarea»: la indicación para la persona que reciba la tarea se suma al borrador. */
  app.patch("/lines/:key/draft", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    const parsed = draftNoteInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const key = c.req.param("key")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        await setAdminDraftNote(tx, orgId, key, parsed.data.taskNote)
        return getAdminLine(tx, orgId, canOf(memberRole), key)
      }),
    )
  })

  app.delete("/lines/:key/draft", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => discardAdminDraft(tx, orgId, userId, c.req.param("key"))))
  })

  /** Eliminar una línea creada por la clínica. Las que vienen armadas se apagan. */
  app.delete("/lines/:key", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.write")) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => deleteAdminLine(tx, orgId, userId, c.req.param("key"))))
  })

  app.get("/lines/:key/people", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.read")) return c.json(errorBody(c, "FORBIDDEN", "Sin acceso al agente"), 403)
    const parsed = peopleQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listAdminLinePeople(tx, orgId, canOf(memberRole), c.req.param("key"), parsed.data),
      ),
    )
  })

  // Con Recepción en «Supervisado», lo que encargó el administrador espera aquí, junto por línea.
  app.get("/approvals", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "agent.decide")) return c.json(errorBody(c, "FORBIDDEN", "Sin permiso para decidir por el agente"), 403)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => listPendingApprovals(tx, orgId)))
  })

  app.post("/approvals/:key", async (c) => {
    const { orgId, memberRole, userId } = orgContextOf(c)
    // Aprobar es dejar salir un mensaje: exige decidir por el agente y poder escribir conversaciones.
    if (!canAccess(memberRole, "agent.decide") || !canAccess(memberRole, "conversations.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso para aprobar mensajes"), 403)
    }
    const parsed = z.object({ decision: z.enum(["aprobar", "rechazar"]) }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        decidePendingApprovals(tx, orgId, userId, c.req.param("key"), parsed.data.decision),
      ),
    )
  })

  // Lo que la persona aceptó recibir sin haber escrito primero. Lo lee y lo
  // registra quien lleva su ficha o su relación con la clínica.
  app.get("/people/:contactId/permissions", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccessAny(memberRole, ["crm.read", "patients.read"])) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso para ver a esta persona"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getMessagePermissions(tx, orgId, c.req.param("contactId"))),
    )
  })

  app.post("/people/:contactId/permissions", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccessAny(memberRole, ["crm.write", "patients.write"])) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso para cambiar a esta persona"), 403)
    }
    const parsed = permissionInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        await setConsent(tx, orgId, userId, c.req.param("contactId"), parsed.data)
        return getMessagePermissions(tx, orgId, c.req.param("contactId"))
      }),
    )
  })

  return app
}
