import { withOrgContext } from "@odentia/db"
import { searchUbigeo } from "@odentia/services"
import { Hono } from "hono"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService } from "./helpers.js"

/** Ubigeo del INEI para domicilio y lugar de nacimiento. */
export function createUbigeoRoute(deps: CrmDeps) {
  const app = new Hono()
  app.get("/", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para ver la filiación"), 403)
    }
    const q = (c.req.query("q") ?? "").slice(0, 80)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => searchUbigeo(tx, q)))
  })
  return app
}
