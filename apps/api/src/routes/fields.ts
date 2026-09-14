import { withOrgContext } from "@odentia/db";
import { createFieldDef, deleteFieldDef, listFieldDefs, updateFieldDef } from "@odentia/services";
import { Hono } from "hono";
import { z } from "zod";
import { canWrite, orgContextOf } from "../lib/context.js";
import { errorBody } from "../lib/error.js";
import { runService, validationError, type CrmDeps } from "./helpers.js";

const createInput = z.object({
  key: z.string().min(1).max(40),
  label: z.string().min(1).max(120),
  type: z.enum(["text", "number", "date", "select"]),
  options: z.array(z.string().max(80)).max(50).optional(),
  position: z.number().int().min(0).max(1000).optional(),
});

const patchInput = z.object({
  label: z.string().min(1).max(120).optional(),
  options: z.array(z.string().max(80)).max(50).optional(),
  position: z.number().int().min(0).max(1000).optional(),
});

export function createFieldsRoute(deps: CrmDeps) {
  const app = new Hono();

  app.get("/", async (c) => {
    const { orgId } = orgContextOf(c);
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => listFieldDefs(tx, orgId)));
  });

  app.post("/", async (c) => {
    const { orgId, memberRole } = orgContextOf(c);
    if (!canWrite(memberRole)) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403);
    const parsed = createInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return runService(c, 201, () => withOrgContext(deps.db, orgId, (tx) => createFieldDef(tx, orgId, parsed.data)));
  });

  app.patch("/:id", async (c) => {
    const { orgId, memberRole } = orgContextOf(c);
    if (!canWrite(memberRole)) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403);
    const parsed = patchInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => updateFieldDef(tx, orgId, c.req.param("id"), parsed.data)),
    );
  });

  app.delete("/:id", async (c) => {
    const { orgId, memberRole } = orgContextOf(c);
    if (!canWrite(memberRole)) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403);
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => deleteFieldDef(tx, orgId, c.req.param("id"))).then(() => ({ ok: true })),
    );
  });

  return app;
}
