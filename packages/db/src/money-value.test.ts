// La cuenta única del valor: la función SQL `money_value` y su espejo en TypeScript
// (`moneyValue` de @odentia/clinical) tienen que decir lo mismo. Y corre con cada
// llave que la usa: el rol de la aplicación y las de Argos.
process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import {
  commissionOfValue,
  convertCents,
  exchangeFactor,
  moneyValue,
  type MoneyFraction,
  refundTenderCents,
  roundMoneyValue,
  sumMoneyValues,
} from "@odentia/clinical"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createAppDb, createOwnerDb, type Db } from "./client.js"

const IMAGE = "dentalagent-postgres:18.6"

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db

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
    .withCommand([
      "postgres",
      "-c",
      "shared_preload_libraries=pg_cron",
      "-c",
      "cron.database_name=dentalagent",
    ])
    .start()
  const host = `${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`
  ownerDb = createOwnerDb(`postgres://dentalagent:dentalagent@${host}`)
  await migrate(ownerDb, { migrationsFolder: "./drizzle" })
  appDb = createAppDb(`postgres://dentalagent_app:dentalagent_app@${host}`)
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

interface Case {
  partCents: number
  amountCents: number
  valueCents: number | null
  currency: string
  businessCurrency: string
  factor: string | null
}

function sqlValue(db: Db, c: Case) {
  return db.execute<{ value: string | null }>(
    sql`select public.money_value(${c.partCents}::numeric, ${c.amountCents}::numeric, ${c.valueCents}::numeric, ${c.currency}, ${c.businessCurrency}, ${c.factor}::numeric)::text as value`,
  )
}

/** El texto decimal de PostgreSQL, como fracción exacta. */
function fractionOf(text: string): MoneyFraction {
  const [integer = "0", fraction = ""] = text.split(".")
  return { num: BigInt(integer + fraction), den: 10n ** BigInt(fraction.length) }
}

const CLP_FACTOR = exchangeFactor("950", "CLP", "USD")
const PEN_PER_CLP = exchangeFactor("0.004", "PEN", "CLP")

const CASES: Case[] = [
  // Con valor congelado: proporción, también con divisiones que no terminan.
  {
    partCents: 33333,
    amountCents: 100000,
    valueCents: 375000,
    currency: "USD",
    businessCurrency: "PEN",
    factor: null,
  },
  {
    partCents: 33334,
    amountCents: 100000,
    valueCents: 375000,
    currency: "USD",
    businessCurrency: "PEN",
    factor: "3.75",
  },
  {
    partCents: 1,
    amountCents: 3,
    valueCents: 100,
    currency: "USD",
    businessCurrency: "PEN",
    factor: null,
  },
  {
    partCents: 8000,
    amountCents: 30000,
    valueCents: 30000,
    currency: "PEN",
    businessCurrency: "PEN",
    factor: null,
  },
  {
    partCents: 123456,
    amountCents: 7654321,
    valueCents: 28703704,
    currency: "USD",
    businessCurrency: "PEN",
    factor: "3.75",
  },
  // Importe cero: nunca divide.
  {
    partCents: 5000,
    amountCents: 0,
    valueCents: 100,
    currency: "USD",
    businessCurrency: "PEN",
    factor: null,
  },
  // Sin valor, en moneda del negocio: lo que dice.
  {
    partCents: 15000,
    amountCents: 15000,
    valueCents: null,
    currency: "PEN",
    businessCurrency: "PEN",
    factor: null,
  },
  {
    partCents: 15000,
    amountCents: 15000,
    valueCents: null,
    currency: "PEN",
    businessCurrency: "PEN",
    factor: "3.75",
  },
  // Sin valor, en otra moneda: el factor de hoy.
  {
    partCents: 100000,
    amountCents: 100000,
    valueCents: null,
    currency: "USD",
    businessCurrency: "PEN",
    factor: "3.75",
  },
  {
    partCents: 33333,
    amountCents: 100000,
    valueCents: null,
    currency: "USD",
    businessCurrency: "PEN",
    factor: "3.7512345",
  },
  // Sin valor y sin factor: no hay valor.
  {
    partCents: 100000,
    amountCents: 100000,
    valueCents: null,
    currency: "USD",
    businessCurrency: "PEN",
    factor: null,
  },
  // Monedas sin decimales: USD 100 a 950 pesos; 45.000 pesos a 0.004 soles.
  {
    partCents: 10000,
    amountCents: 10000,
    valueCents: null,
    currency: "USD",
    businessCurrency: "CLP",
    factor: CLP_FACTOR,
  },
  {
    partCents: 45000,
    amountCents: 45000,
    valueCents: null,
    currency: "CLP",
    businessCurrency: "PEN",
    factor: PEN_PER_CLP,
  },
  {
    partCents: 45000,
    amountCents: 45000,
    valueCents: 18000,
    currency: "CLP",
    businessCurrency: "PEN",
    factor: null,
  },
]

describe("money_value y moneyValue dicen lo mismo", () => {
  it.each(CASES)(
    "$partCents de $amountCents $currency ($businessCurrency, valor $valueCents, factor $factor)",
    async (c) => {
      const [row] = await sqlValue(ownerDb, c)
      const mirror = moneyValue(c)
      if (mirror === null) {
        expect(row?.value).toBeNull()
        return
      }
      const fromSql = fractionOf(row?.value ?? "")
      // Exacto hasta los 25 decimales: lo que no termina se corta en la base muy por debajo del céntimo.
      const gap = fromSql.num * mirror.den - mirror.num * fromSql.den
      const scale = fromSql.den * mirror.den
      expect(
        (gap < 0n ? -gap : gap) * 10n ** 25n <= scale,
        `${row?.value} contra ${mirror.num}/${mirror.den}`,
      ).toBe(true)
      expect(roundMoneyValue(fromSql)).toBe(roundMoneyValue(mirror))
    },
  )

  it("USD 1,000 que valen S/ 3,750, repartidos en 333.33, 333.33 y 333.34, suman 3,750.00 exactos", async () => {
    const parts = [33333, 33333, 33334]
    const [row] = await ownerDb.execute<{ total: string }>(
      sql`select sum(public.money_value(part, 100000, 375000, 'USD', 'PEN', null)) = 375000 as exact,
                 round(sum(public.money_value(part, 100000, 375000, 'USD', 'PEN', null)), 2)::text as total
          from unnest(array[33333, 33333, 33334]::int[]) as part`,
    )
    expect(row).toMatchObject({ exact: true, total: "375000.00" })
    const mirror = sumMoneyValues(
      parts.map((partCents) =>
        moneyValue({
          partCents,
          amountCents: 100000,
          valueCents: 375000,
          currency: "USD",
          businessCurrency: "PEN",
          factor: null,
        }),
      ),
    )
    expect(roundMoneyValue(mirror)).toBe(375000)
    expect(mirror.num).toBe(375000n * mirror.den)
  })

  it("lo mismo cuando el reparto no termina: redondear la suma, no cada fila", async () => {
    // USD 30.00 que valen S/ 10.00 en tres partes iguales: 3.333… cada una.
    const [row] = await ownerDb.execute<{ total: string }>(
      sql`select round(sum(public.money_value(1000, 3000, 1000, 'USD', 'PEN', null)))::text as total from generate_series(1, 3)`,
    )
    expect(row?.total).toBe("1000")
  })

  it("no suma lo que no tiene valor: una clínica que no activó nada da las mismas cifras", async () => {
    const [row] = await ownerDb.execute<{ total: string }>(
      sql`select sum(public.money_value(amount, amount, null, currency, 'PEN', null))::text as total
          from (values (15000, 'PEN'), (5000, 'USD'), (2500, 'PEN')) as t(amount, currency)`,
    )
    expect(row?.total).toBe("17500")
  })

  it("acepta las columnas tal como están: enteros y char(3)", async () => {
    const [row] = await ownerDb.execute<{ value: string }>(
      sql`select round(public.money_value(amount, amount, value, currency, business, factor))::text as value
          from (values (100000::int, 375000::int, 'USD'::char(3), 'PEN'::char(3), 3.75::numeric)) as t(amount, value, currency, business, factor)`,
    )
    expect(row?.value).toBe("375000")
  })
})

describe("las otras cuentas coinciden con su forma en SQL", () => {
  const AMOUNTS = [
    1, 3, 49, 50, 99, 100, 333, 3333, 33333, 53333, 99999, 100000, 375000, 2147483647,
  ]

  it("convertir a la moneda del negocio y desde ella: half-up, como round()", async () => {
    for (const factor of ["3.75", "2.5", "9.5", "0.4", "3.7512345", "40"]) {
      for (const amountCents of AMOUNTS) {
        const [row] = await ownerDb.execute<{ to_business: string; from_business: string }>(
          sql`select round(${amountCents}::numeric * ${factor}::numeric)::text as to_business,
                     round(${amountCents}::numeric / ${factor}::numeric)::text as from_business`,
        )
        expect(
          convertCents({ amountCents, from: "USD", to: "PEN", businessCurrency: "PEN", factor }),
          `${amountCents} × ${factor}`,
        ).toBe(Number(row?.to_business))
        expect(
          convertCents({ amountCents, from: "PEN", to: "USD", businessCurrency: "PEN", factor }),
          `${amountCents} ÷ ${factor}`,
        ).toBe(Number(row?.from_business))
      }
    }
  })

  it("la comisión: multiplica antes de dividir y corta hacia abajo", async () => {
    const lines = [
      { appliedCents: 33333, amountCents: 100000, valueCents: 375000, rateBps: 3333 },
      { appliedCents: 10000, amountCents: 10000, valueCents: 10000, rateBps: 4000 },
      { appliedCents: 1, amountCents: 3, valueCents: 100, rateBps: 1 },
      { appliedCents: 2000000000, amountCents: 2100000000, valueCents: 2147483647, rateBps: 9999 },
    ]
    for (const line of lines) {
      const [row] = await ownerDb.execute<{ cents: string }>(
        sql`select floor(${line.appliedCents}::numeric * ${line.valueCents}::numeric * ${line.rateBps}::numeric / (${line.amountCents}::numeric * 10000))::text as cents`,
      )
      const value = moneyValue({
        partCents: line.appliedCents,
        amountCents: line.amountCents,
        valueCents: line.valueCents,
        currency: "USD",
        businessCurrency: "PEN",
        factor: null,
      })
      if (!value) throw new Error("Con valor congelado siempre hay valor")
      expect(commissionOfValue(value, line.rateBps), JSON.stringify(line)).toBe(Number(row?.cents))
    }
  })

  it("lo devuelto en proporción", async () => {
    const lines = [
      { tenderCents: 8000, amountCents: 30000, previousCents: 0, refundCents: 10000 },
      { tenderCents: 8000, amountCents: 30000, previousCents: 10000, refundCents: 3333 },
      { tenderCents: 375000, amountCents: 100000, previousCents: 33333, refundCents: 1 },
    ]
    for (const line of lines) {
      const [row] = await ownerDb.execute<{ cents: string }>(
        sql`select (round(${line.tenderCents}::numeric * (${line.previousCents}::numeric + ${line.refundCents}::numeric) / ${line.amountCents}::numeric)
                  - round(${line.tenderCents}::numeric * ${line.previousCents}::numeric / ${line.amountCents}::numeric))::text as cents`,
      )
      expect(refundTenderCents(line), JSON.stringify(line)).toBe(Number(row?.cents))
    }
  })
})

describe("quién puede usarla", () => {
  const CALL = sql`select public.money_value(100, 100, 375, 'USD', 'PEN', null)::text as value`

  it("no lee tablas y es inmutable, con su search_path fijo", async () => {
    const [row] = await ownerDb.execute<{ volatility: string; config: string[] }>(
      sql`select provolatile as volatility, proconfig as config from pg_proc where proname = 'money_value'`,
    )
    expect(row?.volatility).toBe("i")
    expect(row?.config?.join(" ")).toContain("search_path")
  })

  it("corre con el rol de la aplicación", async () => {
    const rows = await appDb.execute<{ value: string }>(CALL)
    expect(Number(rows[0]?.value)).toBe(375)
  })

  it.each(["argos_gestion", "argos_recepcion", "argos_clinico", "argos_caja"])(
    "corre con la llave %s, que la aplicación se pone con SET LOCAL ROLE",
    async (key) => {
      const rows = await appDb.transaction(async (tx) => {
        await tx.execute(sql.raw(`set local role ${key}`))
        return tx.execute<{ value: string }>(CALL)
      })
      expect(Number(rows[0]?.value)).toBe(375)
    },
  )

  it("corre con el dueño de las vistas", async () => {
    const rows = await ownerDb.transaction(async (tx) => {
      await tx.execute(sql`set local role argos_dueno`)
      return tx.execute<{ value: string }>(CALL)
    })
    expect(Number(rows[0]?.value)).toBe(375)
  })

  it("el dueño de las vistas ya puede leer las columnas nuevas que usarán", async () => {
    const columns = [
      "patient_payment.tender_cents",
      "patient_payment.tender_currency",
      "patient_payment.exchange_rate",
      "patient_payment.business_cents",
      "expense.tender_cents",
      "expense.tender_currency",
      "expense.exchange_rate",
      "expense.business_cents",
      "org_profile.second_currency",
      "org_profile.exchange_rate",
      "org_profile.exchange_factor",
      "payment_ticket.change_currency",
    ]
    for (const name of columns) {
      const [table = "", column = ""] = name.split(".")
      const [row] = await ownerDb.execute<{ allowed: boolean }>(
        sql`select has_column_privilege('argos_dueno', ${table}, ${column}, 'SELECT') as allowed`,
      )
      expect(row?.allowed, name).toBe(true)
    }
  })

  it("una llave que no es de las listadas no la puede llamar", async () => {
    await ownerDb.execute(sql`create role llave_ajena nologin`)
    await expect(
      ownerDb.transaction(async (tx) => {
        await tx.execute(sql`set local role llave_ajena`)
        await tx.execute(CALL)
      }),
    ).rejects.toThrow()
    await ownerDb.execute(sql`drop role llave_ajena`)
  })
})

describe("las columnas nuevas no aceptan filas a medias", () => {
  it("el pago de un gasto: tender con su moneda, otra que la que cancela, y valor si y solo si hay cambio", async () => {
    await ownerDb.execute(
      sql`insert into "organization" ("id", "name", "slug", "created_at") values ('org_m', 'Clínica', 'clinica-m', now())`,
    )
    const [branch] = await ownerDb.execute<{ id: string }>(
      sql`insert into "branch" ("organization_id", "name") values ('org_m', 'Sede') returning id`,
    )
    const insert = (columns: {
      currency?: string
      tender?: number | null
      tenderCurrency?: string | null
      rate?: string | null
      value?: number | null
    }) =>
      ownerDb.execute(
        sql`insert into "expense" ("organization_id", "branch_id", "concept", "amount_cents", "currency", "tender_cents", "tender_currency", "exchange_rate", "business_cents")
            values ('org_m', ${branch?.id}::uuid, 'Compra', 100000, ${columns.currency ?? "USD"}, ${columns.tender ?? null}::int, ${columns.tenderCurrency ?? null}, ${columns.rate ?? null}::numeric, ${columns.value ?? null}::int)`,
      )
    // Los cuatro ejemplos de lo que se escribe: se aceptan.
    await insert({ tender: 375000, tenderCurrency: "PEN", rate: "3.75", value: 375000 })
    await insert({ rate: "3.75", value: 375000 })
    await insert({
      currency: "PEN",
      tender: 8000,
      tenderCurrency: "USD",
      rate: "3.75",
      value: 100000,
    })
    await insert({ currency: "PEN" })
    // Lo que queda a medias: no.
    await expect(insert({ tender: 375000, rate: "3.75", value: 375000 })).rejects.toThrow()
    await expect(insert({ tenderCurrency: "PEN", rate: "3.75", value: 375000 })).rejects.toThrow()
    await expect(
      insert({ tender: 100, tenderCurrency: "USD", rate: "3.75", value: 375 }),
    ).rejects.toThrow()
    await expect(insert({ tender: 100, tenderCurrency: "PEN" })).rejects.toThrow()
    await expect(
      insert({ tender: -1, tenderCurrency: "PEN", rate: "3.75", value: 375 }),
    ).rejects.toThrow()
    await expect(insert({ rate: "3.75" })).rejects.toThrow()
    await expect(insert({ value: 375000 })).rejects.toThrow()
    await expect(insert({ rate: "0", value: 0 })).rejects.toThrow()
    await expect(insert({ rate: "3.75", value: -1 })).rejects.toThrow()
  })

  it("la segunda moneda de la clínica lleva siempre su cambio y su factor, y no es la del negocio", async () => {
    await ownerDb.execute(
      sql`insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale") values ('org_m', 'Clínica', 'PE', 'PEN', 'America/Lima', 'es-PE')`,
    )
    const set = (
      second: string | null,
      rate: string | null,
      factor: string | null,
      at: Date | null,
    ) =>
      ownerDb.execute(
        sql`update "org_profile" set "second_currency" = ${second}, "exchange_rate" = ${rate}::numeric, "exchange_factor" = ${factor}::numeric, "exchange_rate_at" = ${at?.toISOString() ?? null}::timestamptz where "organization_id" = 'org_m'`,
      )
    const now = new Date()
    await set("USD", "3.75", "3.75", now)
    await set(null, null, null, null)
    await expect(set("USD", null, null, null)).rejects.toThrow()
    await expect(set("USD", "3.75", null, now)).rejects.toThrow()
    await expect(set("USD", "3.75", "3.75", null)).rejects.toThrow()
    await expect(set(null, "3.75", "3.75", now)).rejects.toThrow()
    await expect(set("PEN", "3.75", "3.75", now)).rejects.toThrow()
    await expect(set("usd", "3.75", "3.75", now)).rejects.toThrow()
    await expect(set("USD", "0", "0", now)).rejects.toThrow()
  })

  it("el presupuesto ya no exige moneda y la caja admite el vuelto, una fila por tipo y moneda", async () => {
    const [budget] = await ownerDb.execute<{ nullable: string }>(
      sql`select is_nullable as nullable from information_schema.columns where table_name = 'treatment_budget' and column_name = 'currency'`,
    )
    expect(budget?.nullable).toBe("YES")
    const [index] = await ownerDb.execute<{ def: string }>(
      sql`select indexdef as def from pg_indexes where indexname = 'cash_movement_payment_uidx'`,
    )
    expect(index?.def).toContain("(organization_id, patient_payment_id, kind, currency)")
    const [kinds] = await ownerDb.execute<{ def: string }>(
      sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'cash_movement_kind_check'`,
    )
    expect(kinds?.def).toContain("vuelto")
  })
})
