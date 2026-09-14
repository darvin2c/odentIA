import { withOrgContext } from "@odentia/db";
import { getAgentConfig, upsertAgentConfig } from "@odentia/services";
import { Hono } from "hono";
import { z } from "zod";
import { canWrite, orgContextOf } from "../lib/context.js";
import { errorBody } from "../lib/error.js";
import { runService, validationError, type CrmDeps } from "./helpers.js";

const putInput = z.object({
  enabled: z.boolean().optional(),
  model: z.string().max(120).nullable().optional(),
  systemPrompt: z.string().max(8000).optional(),
  handoffKeywords: z.array(z.string().max(60)).max(30).optional(),
  maxTurns: z.number().int().min(1).max(50).optional(),
});

export function createAgentRoute(deps: CrmDeps) {
  const app = new Hono();

  app.get("/config", async (c) => {
    const { orgId } = orgContextOf(c);
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getAgentConfig(tx, orgId)));
  });

  app.put("/config", async (c) => {
    const { orgId, memberRole } = orgContextOf(c);
    if (!canWrite(memberRole)) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403);
    const parsed = putInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => upsertAgentConfig(tx, orgId, parsed.data)));
  });

  return app;
}
