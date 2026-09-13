import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

export interface DemoTaskPayload {
  orgId: string;
  userId: string;
  message: string;
  requestedAt: string;
}

/** Encola una tarea demo en pgmq; devuelve msg_id como string. */
export async function sendDemoTask(db: Db, payload: DemoTaskPayload): Promise<string> {
  const rows = await db.execute<{ send: number | string }>(
    sql`select pgmq.send('demo_tasks', ${JSON.stringify(payload)}::jsonb)`,
  );
  const first = Array.isArray(rows) ? rows[0] : (rows as unknown as { send: number | string }[])[0];
  return String(first.send);
}
