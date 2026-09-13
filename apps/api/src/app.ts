import type { Auth } from "@odentia/auth";
import { sendDemoTask, withOrgContext, type Db } from "@odentia/db";
import { auditEvent, branch, orgProfile } from "@odentia/db/schema/org";
import { and, eq, gt, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { streamSSE } from "hono/streaming";
import postgres from "postgres";
import { z } from "zod";
import { canWrite, orgContextOf, requireOrgContext, requireSession } from "./lib/context.js";
import { errorBody } from "./lib/error.js";

export interface AppDeps {
  auth: Auth;
  db: Db;
  trustedOrigins: string[];
  cookieDomain: string;
  /** Conexión dedicada LISTEN (postgres.js crudo). */
  listenUrl: string;
}

const branchInput = z.object({
  name: z.string().min(1).max(120),
  addressLine1: z.string().max(200).optional(),
  addressLine2: z.string().max(200).optional(),
  department: z.string().max(80).optional(),
  province: z.string().max(80).optional(),
  district: z.string().max(80).optional(),
  ubigeo: z.string().length(6).optional(),
  phone: z.string().max(30).optional(),
  email: z.string().email().optional(),
  mapsUrl: z.string().url().optional(),
  timezone: z.string().max(60).optional(),
});

const branchPatch = branchInput.partial();

const orgProfileInput = z.object({
  legalName: z.string().min(1).max(200),
  tradeName: z.string().max(200).optional(),
  fiscalDocType: z.string().max(20).optional(),
  fiscalDocNumber: z.string().max(20).optional(),
  billingEmail: z.string().email().optional(),
  fiscalAddress: z.string().max(300).optional(),
  countryCode: z.string().length(2).optional(),
  currency: z.string().length(3).optional(),
  timezone: z.string().max(60).optional(),
  locale: z.string().max(20).optional(),
});

const demoTaskInput = z.object({
  message: z.string().min(1).max(200),
});

interface NotifyPayload {
  orgId: string;
  kind: string;
  taskId: string | number;
  at: string;
}

export function createApp(deps: AppDeps) {
  const { auth, db } = deps;
  const tenantOrigin = new RegExp(
    `^https://[a-z0-9-]+\\.${deps.cookieDomain.replaceAll(".", "\\.")}$`,
  );

  const app = new Hono();

  app.use("*", requestId());
  app.use(
    "*",
    cors({
      origin: (origin) =>
        deps.trustedOrigins.includes(origin) || tenantOrigin.test(origin) ? origin : "",
      credentials: true,
    }),
  );

  app.onError((err, c) => {
    console.error(err);
    return c.json(errorBody(c, "INTERNAL", "Error interno"), 500);
  });
  app.notFound((c) => c.json(errorBody(c, "NOT_FOUND", "Recurso no encontrado"), 404));

  app.get("/health", async (c) => {
    await db.execute(sql`select 1`);
    return c.json({ ok: true });
  });

  // Better Auth: montado ANTES de los guards.
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  // Guards para el resto de /api/*.
  const guarded = new Hono();
  guarded.use("*", requireSession(deps));
  guarded.use("*", requireOrgContext(deps));

  function validationError(c: Context, issues: z.ZodIssue[]) {
    return c.json(
      errorBody(c, "VALIDATION", issues[0]?.message ?? "Datos inválidos"),
      400,
    );
  }

  guarded.get("/org-profile", async (c) => {
    const { orgId } = orgContextOf(c);
    const row = await withOrgContext(db, orgId, async (tx) => {
      const [found] = await tx.select().from(orgProfile).where(eq(orgProfile.organizationId, orgId)).limit(1);
      return found ?? null;
    });
    return c.json({ data: row });
  });

  guarded.put("/org-profile", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c);
    if (!canWrite(memberRole)) {
      return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin pueden editar el perfil"), 403);
    }
    const parsed = orgProfileInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    const input = parsed.data;

    const row = await withOrgContext(db, orgId, async (tx) => {
      const [upserted] = await tx
        .insert(orgProfile)
        .values({ organizationId: orgId, ...input })
        .onConflictDoUpdate({
          target: orgProfile.organizationId,
          set: { ...input, updatedAt: new Date() },
        })
        .returning();
      await tx.insert(auditEvent).values({
        organizationId: orgId,
        actorUserId: userId,
        action: "org_profile.upsert",
        entity: "org_profile",
        entityId: orgId,
        metadata: input,
      });
      return upserted;
    });
    return c.json({ data: row });
  });

  guarded.get("/branches", async (c) => {
    const { orgId } = orgContextOf(c);
    const rows = await withOrgContext(db, orgId, (tx) =>
      tx.select().from(branch).where(eq(branch.organizationId, orgId)).orderBy(branch.name),
    );
    return c.json({ data: rows });
  });

  guarded.post("/branches", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c);
    if (!canWrite(memberRole)) {
      return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin pueden crear sucursales"), 403);
    }
    const parsed = branchInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationError(c, parsed.error.issues);

    const row = await withOrgContext(db, orgId, async (tx) => {
      const [created] = await tx
        .insert(branch)
        .values({ organizationId: orgId, ...parsed.data })
        .returning();
      await tx.insert(auditEvent).values({
        organizationId: orgId,
        actorUserId: userId,
        action: "branch.create",
        entity: "branch",
        entityId: created.id,
        metadata: parsed.data,
      });
      return created;
    });
    return c.json({ data: row }, 201);
  });

  guarded.patch("/branches/:id", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c);
    if (!canWrite(memberRole)) {
      return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin pueden editar sucursales"), 403);
    }
    const id = c.req.param("id");
    const parsed = branchPatch.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationError(c, parsed.error.issues);

    const row = await withOrgContext(db, orgId, async (tx) => {
      const [updated] = await tx
        .update(branch)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(and(eq(branch.id, id), eq(branch.organizationId, orgId)))
        .returning();
      if (updated) {
        await tx.insert(auditEvent).values({
          organizationId: orgId,
          actorUserId: userId,
          action: "branch.update",
          entity: "branch",
          entityId: id,
          metadata: parsed.data,
        });
      }
      return updated ?? null;
    });
    if (!row) return c.json(errorBody(c, "NOT_FOUND", "Sucursal no encontrada"), 404);
    return c.json({ data: row });
  });

  guarded.delete("/branches/:id", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c);
    if (!canWrite(memberRole)) {
      return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin pueden desactivar sucursales"), 403);
    }
    const id = c.req.param("id");
    const row = await withOrgContext(db, orgId, async (tx) => {
      const [updated] = await tx
        .update(branch)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(eq(branch.id, id), eq(branch.organizationId, orgId)))
        .returning({ id: branch.id });
      if (updated) {
        await tx.insert(auditEvent).values({
          organizationId: orgId,
          actorUserId: userId,
          action: "branch.deactivate",
          entity: "branch",
          entityId: id,
        });
      }
      return updated ?? null;
    });
    if (!row) return c.json(errorBody(c, "NOT_FOUND", "Sucursal no encontrada"), 404);
    return c.json({ data: row });
  });

  guarded.post("/demo/tasks", async (c) => {
    const { orgId, userId } = orgContextOf(c);
    const parsed = demoTaskInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    const taskId = await sendDemoTask(db, {
      orgId,
      userId,
      message: parsed.data.message,
      requestedAt: new Date().toISOString(),
    });
    return c.json({ taskId }, 202);
  });

  guarded.get("/notifications/stream", async (c) => {
    const { orgId } = orgContextOf(c);
    const lastEventId = c.req.header("last-event-id");

    return streamSSE(c, async (stream) => {
      // Replay: solo si llega Last-Event-ID; si no, estrictamente en vivo.
      if (lastEventId) {
        const missed = await withOrgContext(db, orgId, (tx) =>
          tx
            .select()
            .from(auditEvent)
            .where(
              and(
                eq(auditEvent.organizationId, orgId),
                eq(auditEvent.action, "demo_task.done"),
                gt(auditEvent.createdAt, new Date(lastEventId)),
              ),
            )
            .orderBy(auditEvent.createdAt),
        );
        for (const event of missed) {
          await stream.writeSSE({
            id: event.createdAt.toISOString(),
            event: "demo_task.done",
            data: JSON.stringify({
              kind: "demo_task.done",
              taskId: event.entityId,
              at: event.createdAt.toISOString(),
            }),
          });
        }
      }

      const listener = postgres(deps.listenUrl, { max: 1 });
      // NOTIFY nunca lleva datos clínicos: solo orgId/kind/taskId/at.
      const { unlisten } = await listener.listen("org_events", async (raw) => {
        let payload: NotifyPayload;
        try {
          payload = JSON.parse(raw) as NotifyPayload;
        } catch {
          return;
        }
        if (payload.orgId !== orgId) return;
        await stream.writeSSE({
          id: payload.at,
          event: payload.kind,
          data: JSON.stringify(payload),
        });
      });

      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: "ping", data: "" }).catch(() => undefined);
      }, 15_000);

      // Mantener el stream abierto hasta abort; cleanup en un solo handler.
      const done = Promise.withResolvers<void>();
      stream.onAbort(() => {
        clearInterval(heartbeat);
        void unlisten().then(() => listener.end());
        done.resolve();
      });
      await done.promise;
    });
  });

  app.route("/api", guarded);
  return app;
}
