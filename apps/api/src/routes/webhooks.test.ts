process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock";

import { createHmac } from "node:crypto";
import { createAppDb, createOwnerDb, type Db } from "@odentia/db";
import { encryptJson, secretsKeyFromEnv } from "@odentia/services";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { createWebhooksRoute } from "./webhooks.js";

const IMAGE = "dentalagent-postgres:18.6";
const KEY = secretsKeyFromEnv("dd".repeat(32));

let container: StartedTestContainer;
let ownerDb: Db;
let appDb: Db;
let tgConn: string;
let waConn: string;
let waSecret = "";

const TG_UPDATE = JSON.stringify({
  update_id: 7001,
  message: {
    message_id: 11,
    date: 1735689600,
    chat: { id: 555 },
    from: { id: 555, first_name: "Ana" },
    text: "Hola",
  },
});

function waBody(): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              messages: [{ from: "51911122233", id: "wamid.W1", timestamp: "1735689600", type: "text", text: { body: "Hola" } }],
            },
            field: "messages",
          },
        ],
      },
    ],
  });
}

function waSig(raw: string): string {
  return `sha256=${createHmac("sha256", "S").update(raw, "utf8").digest("hex")}`;
}

async function queueDepth(): Promise<number> {
  const rows = (await ownerDb.execute(sql`select count(*)::int as n from pgmq.q_inbound_messages`)) as unknown as {
    n: number;
  }[];
  return rows[0]?.n ?? 0;
}

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
  const tg = (await ownerDb.execute(
    sql`insert into "channel_connection"
          ("organization_id", "channel", "provider", "display_name", "config_encrypted", "webhook_secret")
        values ('org_a', 'telegram', 'telegram_bot_api', 'Bot', ${encryptJson(KEY, { botToken: "T" })}, 'tg-secret')
        returning "id", "webhook_secret"`,
  )) as unknown as { id: string; webhook_secret: string }[];
  tgConn = tg[0]?.id ?? "";
  const wa = (await ownerDb.execute(
    sql`insert into "channel_connection"
          ("organization_id", "channel", "provider", "display_name", "config_encrypted", "webhook_secret")
        values ('org_a', 'whatsapp', 'whatsapp_cloud_api', 'WA',
          ${encryptJson(KEY, { phoneNumberId: "P", wabaId: "W", accessToken: "T", appSecret: "S", templates: [] })},
          'wa-secret')
        returning "id", "webhook_secret"`,
  )) as unknown as { id: string; webhook_secret: string }[];
  waConn = wa[0]?.id ?? "";
  waSecret = wa[0]?.webhook_secret ?? "";
}, 180_000);

afterAll(async () => {
  await container?.stop();
});

function route() {
  return createWebhooksRoute({ ownerDb, db: appDb, secretsKey: KEY });
}

it("telegram válido encola; repetido dedupea; secreto malo da 401", async () => {
  const app = route();
  const base = { "x-telegram-bot-api-secret-token": "tg-secret", "content-type": "application/json" };
  const first = await app.request(`/channels/telegram_bot_api/${tgConn}`, {
    method: "POST",
    headers: base,
    body: TG_UPDATE,
  });
  expect(first.status).toBe(200);
  expect(await queueDepth()).toBe(1);

  const dup = await app.request(`/channels/telegram_bot_api/${tgConn}`, {
    method: "POST",
    headers: base,
    body: TG_UPDATE,
  });
  expect(dup.status).toBe(200);
  expect(await queueDepth()).toBe(1);

  const bad = await app.request(`/channels/telegram_bot_api/${tgConn}`, {
    method: "POST",
    headers: { ...base, "x-telegram-bot-api-secret-token": "otro" },
    body: TG_UPDATE,
  });
  expect(bad.status).toBe(401);
  expect(await queueDepth()).toBe(1);
});

it("conexión inexistente o proveedor distinto responde 200 sin encolar", async () => {
  const app = route();
  const res = await app.request("/channels/telegram_bot_api/00000000-0000-0000-0000-000000000000", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": "x" },
    body: TG_UPDATE,
  });
  expect(res.status).toBe(200);
  const cross = await app.request(`/channels/whatsapp_cloud_api/${tgConn}`, {
    method: "POST",
    headers: {},
    body: "{}",
  });
  expect(cross.status).toBe(200);
  expect(await queueDepth()).toBe(1);
});

it("reto GET de WhatsApp valida verify_token", async () => {
  const app = route();
  const ok = await app.request(
    `/channels/whatsapp_cloud_api/${waConn}?hub.mode=subscribe&hub.verify_token=${waSecret}&hub.challenge=CHAL`,
  );
  expect(ok.status).toBe(200);
  expect(await ok.text()).toBe("CHAL");
  const bad = await app.request(
    `/channels/whatsapp_cloud_api/${waConn}?hub.mode=subscribe&hub.verify_token=mal&hub.challenge=CHAL`,
  );
  expect(bad.status).toBe(403);
});

it("whatsapp válido encola con firma HMAC; firma mala da 401", async () => {
  const app = route();
  const raw = waBody();
  const ok = await app.request(`/channels/whatsapp_cloud_api/${waConn}`, {
    method: "POST",
    headers: { "x-hub-signature-256": waSig(raw), "content-type": "application/json" },
    body: raw,
  });
  expect(ok.status).toBe(200);
  expect(await queueDepth()).toBe(2);
  const bad = await app.request(`/channels/whatsapp_cloud_api/${waConn}`, {
    method: "POST",
    headers: { "x-hub-signature-256": "sha256=00", "content-type": "application/json" },
    body: raw,
  });
  expect(bad.status).toBe(401);
  expect(await queueDepth()).toBe(2);
});
