import { withOrgContext } from "@odentia/db";
import {
  assignConversation,
  attachmentUrl,
  closeConversation,
  getConversationDetail,
  listConversations,
  listMessages,
  markRead,
  reopenConversation,
  sendOutbound,
  sendTemplateOutbound,
  setAgentStatus,
} from "@odentia/services";
import { Hono } from "hono";
import { z } from "zod";
import { orgContextOf } from "../lib/context.js";
import { errorBody } from "../lib/error.js";
import { runService, serviceErrorResponse, validationError, type CrmDeps } from "./helpers.js";

const listQuery = z.object({
  status: z.string().optional(),
  channel: z.string().optional(),
  assigned: z.string().optional(),
  q: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const textInput = z.object({ text: z.string().min(1).max(4000) });

const templateInput = z.object({
  name: z.string().min(1),
  language: z.string().min(1),
  params: z.array(z.string()).default([]),
});

const assignInput = z.object({ userId: z.string().nullable() });

const agentInput = z.object({ enabled: z.boolean() });

const messagesQuery = z.object({
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export function createConversationsRoute(deps: CrmDeps) {
  const app = new Hono();

  app.get("/", async (c) => {
    const { orgId } = orgContextOf(c);
    const parsed = listQuery.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.issues);
    try {
      const { items, nextCursor } = await withOrgContext(deps.db, orgId, (tx) =>
        listConversations(tx, orgId, parsed.data),
      );
      return c.json({ data: items, nextCursor });
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e);
    }
  });

  app.get("/:id", async (c) => {
    const { orgId } = orgContextOf(c);
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getConversationDetail(tx, orgId, c.req.param("id"))),
    );
  });

  app.get("/:id/messages", async (c) => {
    const { orgId } = orgContextOf(c);
    const parsed = messagesQuery.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.issues);
    try {
      const { items, nextCursor } = await withOrgContext(deps.db, orgId, (tx) =>
        listMessages(tx, orgId, c.req.param("id"), parsed.data),
      );
      return c.json({ data: items, nextCursor });
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e);
    }
  });

  app.post("/:id/messages", async (c) => {
    const { orgId, userId } = orgContextOf(c);
    const parsed = textInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        sendOutbound(tx, orgId, {
          conversationId: c.req.param("id"),
          senderKind: "user",
          senderUserId: userId,
          content: { type: "text", text: parsed.data.text },
        }),
      ),
    );
  });

  app.post("/:id/messages/template", async (c) => {
    const { orgId, userId } = orgContextOf(c);
    const parsed = templateInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        sendTemplateOutbound(tx, orgId, deps.secretsKey, {
          conversationId: c.req.param("id"),
          senderKind: "user",
          senderUserId: userId,
          ...parsed.data,
        }),
      ),
    );
  });

  app.post("/:id/read", async (c) => {
    const { orgId } = orgContextOf(c);
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => markRead(tx, orgId, c.req.param("id"))).then(() => ({ ok: true })),
    );
  });

  app.post("/:id/assign", async (c) => {
    const { orgId, userId } = orgContextOf(c);
    const parsed = assignInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        assignConversation(tx, orgId, c.req.param("id"), parsed.data.userId, userId),
      ).then(() => ({ ok: true })),
    );
  });

  app.post("/:id/close", async (c) => {
    const { orgId, userId } = orgContextOf(c);
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => closeConversation(tx, orgId, c.req.param("id"), userId)).then(() => ({
        ok: true,
      })),
    );
  });

  app.post("/:id/reopen", async (c) => {
    const { orgId, userId } = orgContextOf(c);
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => reopenConversation(tx, orgId, c.req.param("id"), userId)).then(() => ({
        ok: true,
      })),
    );
  });

  app.post("/:id/agent", async (c) => {
    const { orgId, userId } = orgContextOf(c);
    const parsed = agentInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        setAgentStatus(tx, orgId, c.req.param("id"), parsed.data.enabled, userId),
      ).then(() => ({ ok: true })),
    );
  });

  app.get("/:id/messages/:messageId/attachments/:index", async (c) => {
    const { orgId } = orgContextOf(c);
    const index = Number(c.req.param("index"));
    if (!Number.isInteger(index) || index < 0) {
      return c.json(errorBody(c, "VALIDATION", "Índice inválido"), 400);
    }
    try {
      const url = await withOrgContext(deps.db, orgId, (tx) =>
        attachmentUrl(tx, orgId, c.req.param("messageId"), index, deps.storage),
      );
      return c.redirect(url, 302);
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e);
    }
  });

  return app;
}
