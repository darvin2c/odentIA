import { type Db, type DemoTaskPayload, withOrgContext } from "@odentia/db"
import { auditEvent } from "@odentia/db/schema/org"
import { sql } from "drizzle-orm"

export interface DemoTaskMessage {
  msg_id: number | string
  message: DemoTaskPayload
}

/** Payload NOTIFY: nunca datos clínicos, solo referencias. */
export function buildNotifyPayload(msg: DemoTaskMessage): string {
  return JSON.stringify({
    orgId: msg.message.orgId,
    kind: "demo_task.done",
    taskId: msg.msg_id,
    at: new Date().toISOString(),
  })
}

/**
 * Procesa una tarea demo: registra audit_event dentro del contexto RLS de la
 * org y notifica por LISTEN/NOTIFY. pg_notify se dispara al commit.
 */
export async function processDemoTask(db: Db, msg: DemoTaskMessage): Promise<void> {
  await withOrgContext(db, msg.message.orgId, async (tx) => {
    await tx.insert(auditEvent).values({
      organizationId: msg.message.orgId,
      actorUserId: msg.message.userId,
      action: "demo_task.done",
      entity: "demo_task",
      entityId: String(msg.msg_id),
      metadata: { message: msg.message.message, userId: msg.message.userId },
    })
    await tx.execute(sql`select pg_notify('org_events', ${buildNotifyPayload(msg)})`)
  })
}

/** Ciclo completo: procesa y recién entonces hace ack (delete) del mensaje. */
export async function consumeDemoTask(db: Db, msg: DemoTaskMessage): Promise<void> {
  await processDemoTask(db, msg)
  await db.execute(sql`select pgmq.delete('demo_tasks', ${Number(msg.msg_id)}::bigint)`)
}
