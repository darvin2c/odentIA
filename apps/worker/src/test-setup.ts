process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock";

import { createAppDb, createOwnerDb, withOrgContext, type Db } from "@odentia/db";
import { createConnection, secretsKeyFromEnv } from "@odentia/services";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

const IMAGE = "dentalagent-postgres:18.6";

export const KEY = secretsKeyFromEnv("ff".repeat(32));

export let container: StartedTestContainer;
export let ownerDb: Db;
export let appDb: Db;
export let tgConnId: string;

export const storageStub = {
  putAvatar: async () => {
    throw new Error("no usado");
  },
  deleteByUrl: async () => {},
  putAttachment: async () => {
    throw new Error("no usado");
  },
  attachmentUrl: async (key: string) => `https://signed.example.com/${key}`,
};

export function setupTestDb(): void {
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
    const created = await withOrgContext(appDb, "org_a", (tx) =>
      createConnection(
        tx,
        "org_a",
        KEY,
        { channel: "telegram", provider: "telegram_bot_api", displayName: "Bot", config: { botToken: "T" } },
        { fetch, validateExternal: false },
      ),
    );
    tgConnId = created.id;
  }, 180_000);

  afterAll(async () => {
    await container?.stop();
  });
}

export async function queueDepth(queue: string): Promise<number> {
  const rows = (await ownerDb.execute(
    sql`select count(*)::int as n from pgmq.q_${sql.raw(queue)}`,
  )) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}
