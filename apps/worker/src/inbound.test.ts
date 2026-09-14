import type { NormalizedInbound } from "@odentia/channels";
import { withOrgContext, type InboundMessageJob } from "@odentia/db";
import { message } from "@odentia/db/schema/crm";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { consumeInbound, processInbound } from "./inbound.js";
import { KEY, appDb, ownerDb, queueDepth, setupTestDb, storageStub, tgConnId } from "./test-setup.js";

setupTestDb();

const deps = { storage: storageStub, fetch, secretsKey: KEY };


function job(eventId: string, thread = "tg:555"): { msg_id: number; read_ct: number; message: InboundMessageJob } {
  const event: NormalizedInbound = {
    externalEventId: eventId,
    externalMessageId: eventId,
    externalThreadId: thread,
    senderExternalId: "tg:555",
    senderDisplayName: "Ana",
    content: { type: "text", text: "Hola" },
    sentAt: new Date().toISOString(),
  };
  return { msg_id: 1, read_ct: 0, message: { orgId: "org_a", connectionId: tgConnId, event } };
}

async function messageCount(): Promise<number> {
  return withOrgContext(appDb, "org_a", async (tx) => {
    const rows = await tx.select({ id: message.id }).from(message);
    return rows.length;
  });
}

it("ingesta visible solo en su org y reingesta idempotente", async () => {
  await consumeInbound(appDb, deps, job("evt-a1"));
  expect(await messageCount()).toBe(1);
  const otherOrg = await withOrgContext(appDb, "org_b", (tx) =>
    tx.select({ id: message.id }).from(message),
  );
  expect(otherOrg).toEqual([]);
  // Reintento del mismo evento: no duplica.
  await consumeInbound(appDb, deps, job("evt-a1"));
  expect(await messageCount()).toBe(1);
});

it("con agente habilitado encola agent_runs", async () => {
  await ownerDb.execute(sql`insert into "agent_config" ("organization_id", "enabled") values ('org_a', true)`);
  await consumeInbound(appDb, deps, job("evt-a2", "tg:556"));
  expect(await queueDepth("agent_runs")).toBe(1);
  await ownerDb.execute(sql`delete from "agent_config" where "organization_id" = 'org_a'`);
});

it("conexión inexistente audita y hace ack (sin reintento infinito)", async () => {
  const bad = job("evt-bad");
  bad.message.connectionId = "00000000-0000-0000-0000-000000000000";
  bad.read_ct = 0;
  expect(await processInbound(appDb, deps, bad)).toBe("done");
});

it("veneno tras 5 entregas hace ack", async () => {
  const poison = job("evt-poison");
  poison.message.connectionId = "00000000-0000-0000-0000-000000000000";
  poison.read_ct = 5;
  expect(await processInbound(appDb, deps, poison)).toBe("done");
});
