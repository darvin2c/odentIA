import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createAppDb, createOwnerDb, setupAgentMemory, type Db } from "@odentia/db";
import { createStorage, secretsKeyFromEnv, type Storage } from "@odentia/services";
import { sql } from "drizzle-orm";
import { consumeAgentRun, type AgentRuntime } from "@odentia/agent";
import { env } from "./env.js";
import { processDemoTask, type DemoTaskMessage } from "./handler.js";
import { consumeInbound } from "./inbound.js";
import type { AgentRunJob, InboundMessageJob, OutboundMessageJob, QueueMessage } from "@odentia/db";
import { consumeOutbound } from "./outbound.js";
import { applyLlmEnv, langfuseCallbacks } from "./agent/llm.js";

const db: Db = createAppDb(env.APP_DATABASE_URL);
const secretsKey = secretsKeyFromEnv(env.SECRETS_KEY);
const storage: Storage = createStorage({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  accessKeyId: env.S3_ACCESS_KEY,
  secretAccessKey: env.S3_SECRET_KEY,
  avatarsBucket: env.S3_BUCKET,
  publicBaseUrl: env.S3_PUBLIC_URL,
  attachmentsBucket: env.S3_ATTACHMENTS_BUCKET,
});

// Memoria del agente (tablas LangGraph + RLS) con rol owner; el runtime usa
// el checkpointer con esa misma conexión (aislamiento por thread_id exacto).
applyLlmEnv();
const checkpointer = PostgresSaver.fromConnString(env.DATABASE_URL);
await checkpointer.setup();
await setupAgentMemory(createOwnerDb(env.DATABASE_URL));
const agentRuntime: AgentRuntime = {
  checkpointer,
  modelName: env.LLM_MODEL,
  secretsKey,
  callbacks: await langfuseCallbacks(),
};

const VT_SECONDS = 30;
const BATCH = 1;

let stopping = false;
process.on("SIGINT", () => (stopping = true));
process.on("SIGTERM", () => (stopping = true));

async function readOne<T>(queue: string): Promise<QueueMessage<T> | null> {
  const rows = (await db.execute(
    sql`select msg_id, read_ct, message from pgmq.read(${queue}, ${VT_SECONDS}, ${BATCH})`,
  )) as unknown as { msg_id: number; read_ct: number; message: T }[];
  const first = rows[0];
  return first ? { msg_id: Number(first.msg_id), read_ct: Number(first.read_ct), message: first.message } : null;
}

async function ack(queue: string, msgId: number): Promise<void> {
  await db.execute(sql`select pgmq.delete(${queue}, ${msgId}::bigint)`);
}

interface QueueDef {
  name: string;
  poll: () => Promise<boolean>;
}

const queues: QueueDef[] = [
  {
    name: "demo_tasks",
    poll: async () => {
      const msg = await readOne<DemoTaskMessage["message"]>("demo_tasks");
      if (!msg) return false;
      await processDemoTask(db, { msg_id: msg.msg_id, message: msg.message });
      await ack("demo_tasks", msg.msg_id);
      console.log(`worker: demo_task.done msg_id=${msg.msg_id}`);
      return true;
    },
  },
  {
    name: "inbound_messages",
    poll: async () => {
      const msg = await readOne<InboundMessageJob>("inbound_messages");
      if (!msg) return false;
      await consumeInbound(db, { storage, fetch, secretsKey }, msg);
      console.log(`worker: inbound msg_id=${msg.msg_id}`);
      return true;
    },
  },
  {
    name: "outbound_messages",
    poll: async () => {
      const msg = await readOne<OutboundMessageJob>("outbound_messages");
      if (!msg) return false;
      await consumeOutbound(db, { storage, fetch, secretsKey, senderMode: env.CHANNEL_SENDER_MODE }, msg);
      console.log(`worker: outbound msg_id=${msg.msg_id}`);
      return true;
    },
  },
  {
    name: "agent_runs",
    poll: async () => {
      const msg = await readOne<AgentRunJob>("agent_runs");
      if (!msg) return false;
      await consumeAgentRun(db, agentRuntime, msg);
      console.log(`worker: agent msg_id=${msg.msg_id}`);
      return true;
    },
  },
];

console.log(`worker: consumiendo ${queues.map((q) => q.name).join(", ")}`);
while (!stopping) {
  try {
    let worked = false;
    for (const queue of queues) {
      if (stopping) break;
      try {
        // eslint-disable-next-line no-await-in-loop
        worked = (await queue.poll()) || worked;
      } catch (error) {
        // Sin ack: el mensaje vuelve a ser visible tras el vt.
        console.error(`worker: error en cola ${queue.name}`, error);
      }
    }
    if (!worked) {
      const idle = Promise.withResolvers<void>();
      setTimeout(idle.resolve, 1_000);
      await idle.promise;
    }
  } catch (error) {
    console.error("worker: error en loop", error);
    const backoff = Promise.withResolvers<void>();
    setTimeout(backoff.resolve, 2_000);
    await backoff.promise;
  }
}
process.exit(0);
