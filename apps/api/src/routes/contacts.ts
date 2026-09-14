import { withOrgContext } from "@odentia/db";
import { createContact, getContact, listContacts, updateContact } from "@odentia/services";
import { Hono } from "hono";
import { z } from "zod";
import { orgContextOf } from "../lib/context.js";
import { runService, serviceErrorResponse, validationError, type CrmDeps } from "./helpers.js";

const listQuery = z.object({
  q: z.string().optional(),
  stageId: z.string().uuid().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const createInput = z.object({
  displayName: z.string().min(1).max(200),
  notes: z.string().max(2000).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  stageId: z.string().uuid().optional(),
  assignedUserId: z.string().nullable().optional(),
});

const patchInput = z.object({
  displayName: z.string().min(1).max(200).optional(),
  notes: z.string().max(2000).nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  stageId: z.string().uuid().optional(),
  assignedUserId: z.string().nullable().optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
});

export function createContactsRoute(deps: CrmDeps) {
  const app = new Hono();

  app.get("/", async (c) => {
    const { orgId } = orgContextOf(c);
    const parsed = listQuery.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.issues);
    try {
      const { items, nextCursor } = await withOrgContext(deps.db, orgId, (tx) =>
        listContacts(tx, orgId, parsed.data),
      );
      return c.json({ data: items, nextCursor });
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e);
    }
  });

  app.post("/", async (c) => {
    const { orgId } = orgContextOf(c);
    const parsed = createInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return runService(c, 201, () => withOrgContext(deps.db, orgId, (tx) => createContact(tx, orgId, parsed.data)));
  });

  app.get("/:id", async (c) => {
    const { orgId } = orgContextOf(c);
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getContact(tx, orgId, c.req.param("id"))));
  });

  app.patch("/:id", async (c) => {
    const { orgId } = orgContextOf(c);
    const parsed = patchInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => updateContact(tx, orgId, c.req.param("id"), parsed.data)),
    );
  });

  return app;
}
