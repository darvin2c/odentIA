import { withOrgContext } from "@odentia/db";
import { searchCie10 } from "@odentia/services";
import { Hono } from "hono";
import { orgContextOf } from "../lib/context.js";
import { runService, validationError, type CrmDeps } from "./helpers.js";

export function createCie10Route(deps: CrmDeps) {
  const app = new Hono();
  app.get("/", async (c) => {
    const { orgId } = orgContextOf(c);
    const q = c.req.query("q") ?? "";
    if (q.trim().length < 1) {
      return validationError(c, [{ message: "q es requerido", code: "custom", path: ["q"] }] as never);
    }
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => searchCie10(tx, q.trim())));
  });
  return app;
}
