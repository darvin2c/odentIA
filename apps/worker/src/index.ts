import { createAppDb, type Db } from "@odentia/db";
import { sql } from "drizzle-orm";
import { consumeDemoTask, type DemoTaskMessage } from "./handler.js";

const url = process.env.APP_DATABASE_URL;
if (!url) {
  throw new Error("APP_DATABASE_URL es obligatoria para el worker");
}

const db: Db = createAppDb(url);
const VT_SECONDS = 30;
const BATCH = 1;

let stopping = false;
process.on("SIGINT", () => (stopping = true));
process.on("SIGTERM", () => (stopping = true));

interface RawReadRow {
  read: { msg_id: number; read_ct: number; vt: string; enqueued_at: string; message: DemoTaskMessage["message"] } | null;
}

async function readOne(): Promise<DemoTaskMessage | null> {
  const rows = (await db.execute(
    sql`select pgmq.read('demo_tasks', ${VT_SECONDS}, ${BATCH})`,
  )) as unknown as RawReadRow[];
  const first = rows[0]?.read;
  return first ? { msg_id: first.msg_id, message: first.message } : null;
}

console.log("worker: consumiendo demo_tasks");
while (!stopping) {
  try {
    const msg = await readOne();
    if (!msg) {
      const idle = Promise.withResolvers<void>();
      setTimeout(idle.resolve, 1_000);
      await idle.promise;
      continue;
    }
    await consumeDemoTask(db, msg);
    console.log(`worker: demo_task.done msg_id=${msg.msg_id}`);
  } catch (error) {
    // Sin borrar: el mensaje vuelve a ser visible tras el vt.
    console.error("worker: error procesando mensaje", error);
    const backoff = Promise.withResolvers<void>();
    setTimeout(backoff.resolve, 2_000);
    await backoff.promise;
  }
}
process.exit(0);
