import type { Db } from "@odentia/db"
import { PgDialect } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vitest"
import { consumeDemoTask, type DemoTaskMessage } from "./handler.js"

interface RecordedCall {
  kind: "tx" | "execute" | "insert"
  sql?: string
  params?: unknown[]
  value?: Record<string, unknown>
}

const dialect = new PgDialect()

function createFakeDb() {
  const calls: RecordedCall[] = []
  const tx = {
    execute: async (wrapper: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      const query = dialect.sqlToQuery(wrapper)
      calls.push({ kind: "execute", sql: query.sql, params: query.params })
    },
    insert: () => ({
      values: async (value: Record<string, unknown>) => {
        calls.push({ kind: "insert", value })
      },
    }),
  }
  const db = {
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
      calls.push({ kind: "tx" })
      return fn(tx)
    },
    execute: tx.execute,
  }
  return { db: db as unknown as Db, calls }
}

const msg: DemoTaskMessage = {
  msg_id: 42,
  message: {
    orgId: "org_1",
    userId: "user_1",
    message: "hola",
    requestedAt: "2026-09-12T00:00:00.000Z",
  },
}

describe("consumeDemoTask", () => {
  it("registra audit_event y pg_notify con orgId/taskId del mensaje", async () => {
    const { db, calls } = createFakeDb()
    await consumeDemoTask(db, msg)

    const audit = calls.find((c) => c.kind === "insert")
    expect(audit?.value).toMatchObject({
      organizationId: "org_1",
      actorUserId: "user_1",
      action: "demo_task.done",
      entityId: "42",
    })

    const notify = calls.find((c) => c.kind === "execute" && c.sql?.includes("pg_notify"))
    expect(notify).toBeDefined()
    const notifyPayload = JSON.parse(String(notify!.params![0])) as Record<string, unknown>
    expect(notifyPayload).toMatchObject({ orgId: "org_1", kind: "demo_task.done", taskId: 42 })
  })

  it("hace ack (pgmq.delete) solo después de notificar", async () => {
    const { db, calls } = createFakeDb()
    await consumeDemoTask(db, msg)

    const notifyIdx = calls.findIndex((c) => c.kind === "execute" && c.sql?.includes("pg_notify"))
    const ackIdx = calls.findIndex((c) => c.kind === "execute" && c.sql?.includes("pgmq.delete"))
    expect(notifyIdx).toBeGreaterThanOrEqual(0)
    expect(ackIdx).toBeGreaterThan(notifyIdx)
    expect(calls[ackIdx]?.params).toEqual([42])
  })
})
