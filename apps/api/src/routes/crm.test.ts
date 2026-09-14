process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock";

import { createAppDb, createOwnerDb, withOrgContext, type Db } from "@odentia/db";
import { createConnection, ingestInbound, secretsKeyFromEnv, type IngestDeps } from "@odentia/services";
import { telegramBotApiAdapter } from "@odentia/channels";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { Hono, type Next } from "hono";
import type { Context } from "hono";
import { afterAll, beforeAll, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { createAgentRoute } from "./agent.js";
import { createConnectionsRoute } from "./connections.js";
import { createContactsRoute } from "./contacts.js";
import { createConversationsRoute } from "./conversations.js";
import { createFieldsRoute } from "./fields.js";
import type { CrmDeps } from "./helpers.js";
import { createPipelinesRoute } from "./pipelines.js";
import { createTasksRoute } from "./tasks.js";

const IMAGE = "dentalagent-postgres:18.6";
const KEY = secretsKeyFromEnv("ee".repeat(32));

let container: StartedTestContainer;
let ownerDb: Db;
let appDb: Db;

const storageStub = {
  putAvatar: async () => {
    throw new Error("no usado");
  },
  deleteByUrl: async () => {},
  putAttachment: async () => {
    throw new Error("no usado");
  },
  attachmentUrl: async (key: string) => `https://signed.example.com/${key}`,
};

function stubOrg(role: string) {
  return async (c: Context, next: Next) => {
    c.set("orgId", "org_a");
    c.set("userId", "u-1");
    c.set("memberRole", role);
    await next();
  };
}

function buildApp(role: string): Hono {
  const deps: CrmDeps = {
    db: appDb,
    secretsKey: KEY,
    storage: storageStub,
    validateExternal: false,
    webhookBaseUrl: "https://api.example.com",
  };
  const app = new Hono();
  app.use("*", stubOrg(role));
  app.route("/conversations", createConversationsRoute(deps));
  app.route("/contacts", createContactsRoute(deps));
  app.route("/pipelines", createPipelinesRoute(deps));
  app.route("/channels/connections", createConnectionsRoute(deps));
  app.route("/agent", createAgentRoute(deps));
  app.route("/tasks", createTasksRoute(deps));
  app.route("/fields", createFieldsRoute(deps));
  return app;
}

let waConnId = "";
let conversationId = "";

beforeAll(async () => {
  container = await new GenericContainer(IMAGE)
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_DB: "dentalagent",
      POSTGRES_USER: "dentalagent",
      POSTGRES_PASSWORD: "dentalagent",
      POSTGRES_APP_PASSWORD: "dentalagent_app",
    })
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .withCommand(["postgres", "-c", "shared_preload_libraries=pg_cron", "-c", "cron.database_name=dentalagent"])
    .start();
  const uri = `postgres://dentalagent:dentalagent@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`;
  ownerDb = createOwnerDb(uri);
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" });
  appDb = createAppDb(
    `postgres://dentalagent_app:dentalagent_app@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`,
  );
  await ownerDb.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at") values ('org_a', 'Clínica', 'norte', now())`,
  );
  const wa = await withOrgContext(appDb, "org_a", (tx) =>
    createConnection(
      tx,
      "org_a",
      KEY,
      {
        channel: "whatsapp",
        provider: "whatsapp_cloud_api",
        displayName: "WA",
        config: { phoneNumberId: "P", wabaId: "W", accessToken: "T", appSecret: "S", templates: [] },
      },
      { fetch, validateExternal: false },
    ),
  );
  waConnId = wa.id;
  const deps: IngestDeps = { storage: storageStub, fetch, secretsKey: KEY };
  const ingested = await withOrgContext(appDb, "org_a", (tx) =>
    ingestInbound(
      tx,
      {
        orgId: "org_a",
        connectionId: waConnId,
        event: {
          externalEventId: "wamid.seed",
          externalMessageId: "wamid.seed",
          externalThreadId: "wa:519",
          senderExternalId: "wa:519",
          senderDisplayName: "Luis",
          content: { type: "text", text: "Hola" },
          sentAt: new Date().toISOString(),
        },
      },
      telegramBotApiAdapter,
      deps,
    ),
  );
  conversationId = ingested.conversationId;
}, 180_000);

afterAll(async () => {
  await container?.stop();
});

it("bandeja: lista, detalle y envío dentro de ventana", async () => {
  const app = buildApp("owner");
  const list = await app.request("/conversations");
  expect(list.status).toBe(200);
  const listBody = (await list.json()) as { data: { id: string }[] };
  expect(listBody.data.map((c) => c.id)).toContain(conversationId);

  const detail = await app.request(`/conversations/${conversationId}`);
  expect(detail.status).toBe(200);

  const sent = await app.request(`/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Hola Luis" }),
  });
  expect(sent.status).toBe(201);
});

it("fuera de ventana 24h responde WINDOW_CLOSED 409", async () => {
  await ownerDb.execute(
    sql`update "conversation" set "last_inbound_at" = now() - interval '25 hours' where "id" = ${conversationId}::uuid`,
  );
  const app = buildApp("owner");
  const res = await app.request(`/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "tarde" }),
  });
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ error: { code: "WINDOW_CLOSED" } });
  await ownerDb.execute(sql`update "conversation" set "last_inbound_at" = now() where "id" = ${conversationId}::uuid`);
});

it("contactos: crear, validar y ver detalle", async () => {
  const app = buildApp("owner");
  const bad = await app.request("/contacts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "" }),
  });
  expect(bad.status).toBe(400);
  const created = await app.request("/contacts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Rosa" }),
  });
  expect(created.status).toBe(201);
  const createdBody = (await created.json()) as { data: { id: string } };
  const detail = await app.request(`/contacts/${createdBody.data.id}`);
  expect(detail.status).toBe(200);
});

it("pipelines asegura default; miembro no puede crear", async () => {
  const app = buildApp("owner");
  const list = await app.request("/pipelines");
  expect(list.status).toBe(200);
  const body = (await list.json()) as { data: { name: string }[] };
  expect(body.data[0]?.name).toBe("Ventas");

  const member = buildApp("member");
  const forbidden = await member.request("/pipelines", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Otro" }),
  });
  expect(forbidden.status).toBe(403);
});

it("conexiones listan webhookUrl sin secretos; agente con gating", async () => {
  const app = buildApp("owner");
  const list = await app.request("/channels/connections");
  const body = (await list.json()) as { data: { webhookUrl: string; externalId: null }[] };
  expect(body.data[0]?.webhookUrl).toBe(`https://api.example.com/api/webhooks/channels/whatsapp_cloud_api/${waConnId}`);
  expect(JSON.stringify(body.data)).not.toContain("configEncrypted");

  const put = await app.request("/agent/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  expect(put.status).toBe(200);
  const member = buildApp("member");
  const forbidden = await member.request("/agent/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  expect(forbidden.status).toBe(403);
});

it("tareas y campos van de punta a punta", async () => {
  const app = buildApp("owner");
  const task = await app.request("/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Llamar" }),
  });
  expect(task.status).toBe(201);
  const tasks = await app.request("/tasks?status=open");
  expect(tasks.status).toBe(200);

  const field = await app.request("/fields", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "sede", label: "Sede", type: "select", options: ["a"] }),
  });
  expect(field.status).toBe(201);
  const fields = await app.request("/fields");
  expect(((await fields.json()) as { data: unknown[] }).data).toHaveLength(1);
});
