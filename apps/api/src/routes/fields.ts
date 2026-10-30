import { withOrgContext } from "@odentia/db"
import { createFieldDef, deleteFieldDef, listFieldDefs, updateFieldDef } from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

/** Opciones de una lista: hasta 50, cada una de hasta 80 caracteres; el error dice qué línea. */
const optionsInput = z
  .array(z.string())
  .max(50, "Una lista admite hasta 50 opciones")
  .superRefine((list, ctx) => {
    const line = list.findIndex((option) => option.trim().length > 80)
    if (line >= 0) {
      ctx.addIssue({ code: "custom", message: `La opción ${line + 1} pasa de 80 caracteres: acórtala` })
    }
  })

const labelInput = z
  .string()
  .trim()
  .min(1, "Escribe el nombre del campo")
  .max(120, "El nombre del campo admite hasta 120 caracteres")

const createInput = z.object({
  /** Opcional: sin ella, el servicio la genera a partir del nombre. */
  key: z.string().min(1).max(40).optional(),
  label: labelInput,
  type: z.enum(["text", "number", "date", "select"], "Elige el tipo del campo: texto, número, fecha o lista de opciones"),
  options: optionsInput.optional(),
  position: z.number().int().min(0).max(1000).optional(),
})

const patchInput = z.object({
  label: labelInput.optional(),
  options: optionsInput.optional(),
  position: z.number().int().min(0).max(1000).optional(),
})

/**
 * Campos de contacto. Leerlos es de quien trabaja con contactos (los llena en
 * la ficha) y de quien configura; definirlos —crear, editar, eliminar— también
 * es de quien trabaja con contactos (`crm.write`): es parte del trabajo diario
 * de ventas, la misma regla que abre su apartado en Configuración.
 */
export function createFieldsRoute(deps: CrmDeps) {
  const app = new Hono()

  app.get("/", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "crm.read") && !canAccess(memberRole, "settings.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para ver los campos"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listFieldDefs(tx, orgId)),
    )
  })

  app.post("/", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "crm.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para cambiar los campos de contacto"), 403)
    }
    const parsed = createInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => createFieldDef(tx, orgId, parsed.data)),
    )
  })

  app.patch("/:id", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "crm.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para cambiar los campos de contacto"), 403)
    }
    const parsed = patchInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        updateFieldDef(tx, orgId, c.req.param("id"), parsed.data),
      ),
    )
  })

  app.delete("/:id", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "crm.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para cambiar los campos de contacto"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => deleteFieldDef(tx, orgId, c.req.param("id"))).then(
        () => ({ ok: true }),
      ),
    )
  })

  return app
}
