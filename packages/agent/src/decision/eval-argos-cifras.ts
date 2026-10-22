/**
 * El cuadre de las cifras oficiales de Argos (ADR 0078, D18) con Reportes,
 * sobre una base con datos (la del examen): cada cifra que también está en
 * Reportes, en varios periodos y por sede, tiene que dar lo mismo. Además
 * corre cada cifra con cada uno de sus cortes, para ver que su consulta pasa
 * el revisor y la base la acepta. No usa ningún modelo.
 *
 *   pnpm -s eval:argos-cifras -- [--org=seed-org-dental-smile]
 */
import { createAppDb, withOrgContext } from "@odentia/db"
import {
  ARGOS_FIGURES,
  argosFigure,
  bindArgosPeriod,
  compileArgosFigure,
  computeFigure,
  type FigureContext,
  getOrgLocale,
  listArgosBranches,
  listArgosNames,
  reportScope,
  resolveArgosPeriod,
  runArgosQuery,
} from "@odentia/services"

const arg = (name: string, fallback: string) =>
  process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const ORG = arg("org", "seed-org-dental-smile")
const url = process.env.APP_DATABASE_URL
if (!url) throw new Error("Falta APP_DATABASE_URL (el .env de infra/dev)")
const db = createAppDb(url)
const now = new Date()
const PERIODS = ["este_mes", "mes_pasado", "ultimos_3_meses", "este_ano"]

const { zone, branches, names } = await withOrgContext(db, ORG, async (tx) => ({
  zone: await getOrgLocale(tx, ORG),
  branches: await listArgosBranches(tx, ORG),
  names: await listArgosNames(tx, ORG, "gestion"),
}))

/** Una cifra de Argos con su periodo y su sede: el valor de la primera fila. */
async function argosValue(
  key: string,
  period: string,
  branch: string | null,
  ask: { por?: string[] } = {},
): Promise<{ value: number | null; rows: number } | { problem: string }> {
  const figure = argosFigure(key)
  if (!figure) return { problem: "no existe" }
  const compiled = compileArgosFigure(
    { cifra: key, ...ask },
    { key: "gestion", compare: false, names },
  )
  if ("problem" in compiled) return compiled
  const resolved = resolveArgosPeriod(
    { periodo: figure.time === "a_hoy" ? "a_hoy" : period, compara: "no" },
    zone,
    now,
  )
  const bound = bindArgosPeriod(compiled.sql, resolved, branch)
  if ("problem" in bound) return bound
  try {
    const result = await runArgosQuery(db, { orgId: ORG, memberRole: "owner", query: bound.sql })
    const value = result.rows[0]?.[compiled.column]
    return {
      value: value === null || value === undefined ? null : Number(value),
      rows: result.rows.length,
    }
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) }
  }
}

/** Lo que dice Reportes de esa cifra, en la unidad de Argos (el dinero sin centavos). */
async function reportValue(
  report: string,
  period: string,
  branchId: string | null,
): Promise<number | null> {
  return withOrgContext(db, ORG, async (tx) => {
    const scope = await reportScope(tx, ORG, { period, ...(branchId ? { branchId } : {}) }, now)
    const ctx: FigureContext = { tx, orgId: ORG, scope, billing: true }
    const result = await computeFigure(ctx, { figure: report, group: "total" })
    const value = result.total.value
    if (value === null) return null
    return result.figure.unit === "money"
      ? value / 100
      : result.figure.unit === "hours"
        ? value / 60
        : value
  })
}

let checked = 0
let off = 0
console.log("## Cuadre con Reportes\n")
for (const figure of ARGOS_FIGURES.filter((item) => item.report)) {
  const periods = figure.time === "a_hoy" ? ["este_mes"] : PERIODS
  const sedes: Array<{ id: string; name: string } | null> = [
    null,
    ...(figure.sources.some((source) => source.cuts.includes("sede")) ? branches : []),
  ]
  for (const period of periods)
    for (const sede of sedes) {
      const mine = await argosValue(figure.key, period, sede?.name ?? null)
      const theirs = await reportValue(figure.report ?? "", period, sede?.id ?? null).catch(
        (error: unknown) => `error: ${error instanceof Error ? error.message : String(error)}`,
      )
      checked += 1
      const where = `${figure.key} · ${period}${sede ? ` · ${sede.name}` : ""}`
      if ("problem" in mine) {
        off += 1
        console.log(`✗ ${where}: Argos no corrió (${mine.problem})`)
        continue
      }
      const same =
        typeof theirs === "number"
          ? mine.value !== null &&
            Math.abs(mine.value - theirs) <= Math.max(0.011, Math.abs(theirs) * 0.001)
          : theirs === null && (mine.value === null || mine.value === 0)
      // La agenda va por día: con un periodo que llega a hoy, Argos cuenta hoy entero y Reportes hasta este minuto (lo dice «Así lo calculé»).
      const today = figure.time === "dia" && (period === "este_mes" || period === "este_ano")
      if (!same && today)
        console.log(`≈ ${where}: Argos ${mine.value} · Reportes ${theirs} (hoy entero)`)
      else if (!same) {
        off += 1
        console.log(`✗ ${where}: Argos ${mine.value} · Reportes ${theirs}`)
      }
    }
}
console.log(`\n${checked - off} de ${checked} cuadran.`)

console.log("\n## Cada cifra con cada corte\n")
let broken = 0
for (const figure of ARGOS_FIGURES) {
  const cuts = [...new Set(figure.sources.flatMap((source) => source.cuts))]
  for (const cut of [null, ...cuts]) {
    const mine = await argosValue(figure.key, "este_mes", null, cut ? { por: [cut] } : {})
    if ("problem" in mine) {
      broken += 1
      console.log(`✗ ${figure.key}${cut ? ` por ${cut}` : ""}: ${mine.problem}`)
    }
  }
}
console.log(broken ? `\n${broken} consultas no corrieron.` : "\nTodas las consultas corrieron.")
process.exit(off || broken ? 1 : 0)
