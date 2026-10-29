import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/**
 * El backup restaura cada volcado antes de subirlo (infra/prod/backup): su
 * imagen necesita las mismas extensiones, en las mismas versiones, que la de la
 * base (infra/dev/postgres, la de producción). Una versión nueva va en las dos.
 */
const root = new URL("../../../", import.meta.url)
const argsOf = (path: string) =>
  Object.fromEntries(
    [...readFileSync(new URL(path, root), "utf8").matchAll(/^ARG (\w+_REF)=(\S+)$/gm)].map((match) => [match[1], match[2]]),
  )
const baseOf = (path: string) => readFileSync(new URL(path, root), "utf8").match(/^FROM (postgres:\S+)$/m)?.[1]

describe("imagen del backup", () => {
  it("tiene la misma PostgreSQL y las mismas extensiones que la base", () => {
    const base = argsOf("infra/dev/postgres/Dockerfile")
    expect(Object.keys(base).sort()).toEqual(["PGMQ_REF", "PGVECTOR_REF", "PG_CRON_REF"])
    expect(argsOf("infra/prod/backup/Dockerfile")).toEqual(base)
    expect(baseOf("infra/prod/backup/Dockerfile")).toBe(baseOf("infra/dev/postgres/Dockerfile"))
    // compose.prod.yaml fija pgmq y pg_cron al construir la base: los mismos.
    const compose = readFileSync(new URL("compose.prod.yaml", root), "utf8")
    expect(compose).toContain(`PGMQ_REF: ${base.PGMQ_REF}`)
    expect(compose).toContain(`PG_CRON_REF: ${base.PG_CRON_REF}`)
  })
})
