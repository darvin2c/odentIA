/**
 * La medición de la IA de fotos («cero datos inventados»). Uso:
 *
 *   pnpm --filter @gestoria/api eval:fotos [-- --casos=id1,id2] [--repeticiones=N] [--sin-juez]
 *     [--modelo=gpt-6-luna] [--salida=ruta.json] [--estimar]
 *
 * Corre la IA de verdad (`lookAtProduct` y `groupLoosePhotos`, con su revisión) sobre el banco
 * `eval/fotos.json`, escrito por el equipo mirando cada foto (nunca fotos de una tienda): para
 * cada producto, lo que se ve, lo que no se ve y lo que nunca puede decir. Las fotos pasan por
 * las mismas copias que en la app (`photoCopies`: la de la vitrina para mirar un producto, la
 * miniatura para juntar). Sin base de datos: la plantilla es la fija de cada rubro.
 *
 * Lo que se cuenta, sin modelo (reglas fijas sobre lo que quedó propuesto, después de la revisión):
 *   - Inventados: un dato que no se ve (o con otro valor del que se ve), uno que el banco no
 *     prevé, o una palabra de «nunca» en lo propuesto. En «juntar», dos fotos juntas que no son
 *     del mismo producto.
 *   - Preguntas correctas: de lo que debe preguntar, cuánto preguntó.
 *   - Aciertos: el rubro, el nombre, cada color, cada dato que se ve, lo leído; en «juntar», cada
 *     par de fotos que sí va junto.
 *   - Lo que la revisión del servidor descartó (lo que habría llegado sin ella).
 *   - El costo (tokens y USD, con el precio de lista).
 * Después, un juez (el mismo modelo, razonamiento medio) mira las fotos y lo propuesto y anota lo
 * que afirma algo que no se ve. Nunca quita un inventado de las reglas.
 *
 * Necesita `GESTORIA_OPENAI_API_KEY`. Con `GESTORIA_FOTOS_MODEL=fake` corre sin red, sin juez ni
 * gasto: sirve para ver que la medición anda, no cuenta como medición. `--estimar` dice cuántas
 * llamadas haría y cuánto costaría, sin llamar a nadie.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { PRODUCT_RUBROS, type ProductRubro } from "@gestoria/db"
import { z } from "zod"
import {
  groupLoosePhotos,
  type LookResult,
  lookAtProduct,
  PHOTOS_MODEL,
  type PhotoIn,
  type ProposalDraft,
  photosModelFromEnv,
} from "./ia-fotos.js"
import { photoCopies } from "./imagenes.js"
import { RUBROS, type TemplateField } from "./rubros.js"
import { type ChatModel, costMicros, openAIModel, type Usage } from "./sofi/modelo.js"

const BANK_DIR = new URL("../eval/", import.meta.url)

const bankSchema = z.object({
  creditos: z.record(z.string(), z.string()),
  casos: z.array(
    z.object({
      id: z.string(),
      fotos: z.array(z.string()).min(1),
      producto: z.string(),
      mezcla: z.boolean().optional(),
      se_ve: z.object({
        rubro: z.enum(PRODUCT_RUBROS).optional(),
        nombre: z.array(z.string()),
        colores: z.array(z.array(z.string())),
        datos: z.record(z.string(), z.array(z.string())),
        leido: z.array(z.string()),
      }),
      puede: z.array(z.string()),
      no_se_ve: z.array(z.string()),
      debe_preguntar: z.array(z.string()),
      nunca: z.array(z.string()),
    }),
  ),
  juntar: z.array(
    z.object({
      id: z.string(),
      fotos: z.array(z.string()).min(2),
      grupos: z.array(z.array(z.string())),
      puede_juntar: z.array(z.array(z.string())),
    }),
  ),
})
type Bank = z.infer<typeof bankSchema>
type Case = Bank["casos"][number]

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()

/** Si `term` aparece en `text` desde el principio de una palabra, sin tildes. */
const mentions = (text: string, term: string) =>
  new RegExp(`(^|[^a-z0-9])${fold(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(fold(text))

function textOf(p: ProposalDraft): string {
  if (p.field === "color") return p.value.name
  if (p.field === "palabras") return p.value.join(", ")
  if (p.field === "juntar" || p.field.startsWith("pregunta:")) return ""
  return String(p.value)
}

interface Scored {
  inventados: { que: string; detalle: string }[]
  preguntas: { esperadas: number; hechas: number; faltan: string[] }
  aciertos: { posibles: number; logrados: number; faltan: string[] }
}

/** Cuenta lo propuesto contra el banco, con reglas fijas. */
export function scoreLook(item: Case, look: Omit<LookResult, "usage" | "model">): Scored {
  const inventados: Scored["inventados"] = []
  const props = look.proposals
  const data = props.filter((p) => p.field.startsWith("dato:"))
  for (const p of data) {
    const key = p.field.slice(5)
    const value = String(p.value)
    if (item.no_se_ve.includes(key))
      inventados.push({ que: `dato ${key}`, detalle: `«${value}» no se ve: debía preguntar` })
    else if (item.se_ve.datos[key]) {
      if (!item.se_ve.datos[key]!.some((v) => fold(v) === fold(value)))
        inventados.push({ que: `dato ${key}`, detalle: `«${value}», y lo que se ve es otro` })
    } else if (!item.puede.includes(key))
      inventados.push({ que: `dato ${key}`, detalle: `«${value}», que el banco no prevé` })
  }
  for (const p of props) {
    const text = textOf(p)
    for (const term of item.nunca)
      if (text && mentions(text, term))
        inventados.push({ que: p.field, detalle: `dice «${term}»: «${text.slice(0, 120)}»` })
  }

  const asked = new Set(
    props.filter((p) => p.field.startsWith("pregunta:")).map((p) => p.field.slice(9)),
  )
  const faltanPreguntas = item.debe_preguntar.filter((k) => !asked.has(k))

  const goals: [string, boolean][] = []
  if (item.mezcla) goals.push(["avisa que son varios productos", !look.sameProduct])
  if (item.se_ve.rubro) {
    const rubro = props.find((p) => p.field === "rubro")?.value
    goals.push([`rubro ${item.se_ve.rubro}`, rubro === item.se_ve.rubro])
  }
  if (item.se_ve.nombre.length) {
    const name = props.find((p) => p.field === "nombre")
    goals.push([
      `nombre con ${item.se_ve.nombre.join("/")}`,
      !!name && item.se_ve.nombre.some((w) => mentions(textOf(name), w)),
    ])
  }
  const colors = props.filter((p) => p.field === "color").map(textOf)
  for (const names of item.se_ve.colores)
    goals.push([
      `color ${names[0]}`,
      colors.some((c) => names.some((n) => fold(c) === fold(n) || mentions(c, n))),
    ])
  for (const [key, values] of Object.entries(item.se_ve.datos))
    goals.push([
      `dato ${key} ${values[0]}`,
      data.some(
        (p) => p.field === `dato:${key}` && values.some((v) => fold(v) === fold(String(p.value))),
      ),
    ])
  for (const word of item.se_ve.leido)
    goals.push([`lee «${word}»`, look.read.some((t) => fold(t).includes(fold(word)))])

  return {
    inventados,
    preguntas: {
      esperadas: item.debe_preguntar.length,
      hechas: item.debe_preguntar.length - faltanPreguntas.length,
      faltan: faltanPreguntas,
    },
    aciertos: {
      posibles: goals.length,
      logrados: goals.filter(([, ok]) => ok).length,
      faltan: goals.filter(([, ok]) => !ok).map(([what]) => what),
    },
  }
}

/** Cuenta los pares de fotos juntadas contra los grupos del banco. */
export function scoreGroups(item: Bank["juntar"][number], proposals: ProposalDraft[]): Scored {
  const pairs = (groups: string[][]) =>
    new Set(
      groups.flatMap((g) =>
        g.flatMap((a, i) => g.slice(i + 1).map((b) => [a, b].sort().join("+"))),
      ),
    )
  const wanted = pairs(item.grupos)
  const allowed = pairs(item.puede_juntar)
  const made = pairs(proposals.flatMap((p) => (p.field === "juntar" ? [p.value.photos] : [])))
  const inventados = [...made]
    .filter((pair) => !wanted.has(pair) && !allowed.has(pair))
    .map((pair) => ({ que: "juntar", detalle: `juntó ${pair}, que no son del mismo producto` }))
  const missing = [...wanted].filter((pair) => !made.has(pair))
  return {
    inventados,
    preguntas: { esperadas: 0, hechas: 0, faltan: [] },
    aciertos: { posibles: wanted.size, logrados: wanted.size - missing.length, faltan: missing },
  }
}

/* ------------------------------------------------------------------------------ el juez */

const JUDGE = `Eres el juez de una IA que propone los datos de un producto a partir de sus fotos. La regla es una sola: no puede afirmar nada que no se vea en las fotos o no esté escrito en ellas (material, medidas, cualidades, compatibilidad, contenido, marca, si es nuevo). Lees lo propuesto y miras las fotos. Respondes solo con el JSON pedido: cada afirmación que no se ve, con el texto exacto y por qué. Si todo se ve, la lista va vacía. El color aproximado, la forma, los detalles visibles y lo escrito en la foto sí se ven.`

const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["inventos"],
  properties: {
    inventos: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["texto", "por_que"],
        properties: { texto: { type: "string" }, por_que: { type: "string" } },
      },
    },
  },
} as const

async function judge(model: ChatModel, photos: PhotoIn[], item: Case, look: LookResult) {
  const shown = look.proposals
    .filter((p) => !p.field.startsWith("pregunta:"))
    .map((p) => `${p.field}: ${textOf(p)}`)
    .join("\n")
  if (!shown) return { inventos: [] as { texto: string; por_que: string }[], usage: null }
  const reply = await model.complete({
    messages: [
      { role: "system", content: JUDGE },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Producto (para ubicarte): ${item.producto}\n\nLo propuesto:\n${shown}`,
          },
          ...photos.flatMap((photo, i) => [
            { type: "text" as const, text: `Foto ${i + 1}:` },
            {
              type: "image_url" as const,
              image_url: {
                url: `data:${photo.contentType};base64,${Buffer.from(photo.bytes).toString("base64")}`,
                detail: "high" as const,
              },
            },
          ]),
        ],
      },
    ],
    responseFormat: {
      type: "json_schema",
      json_schema: { name: "juicio", strict: true, schema: JUDGE_SCHEMA },
    },
  })
  try {
    const json = z
      .object({ inventos: z.array(z.object({ texto: z.string(), por_que: z.string() })) })
      .parse(JSON.parse(reply.content ?? ""))
    return { inventos: json.inventos, usage: reply.usage }
  } catch {
    return { inventos: [], usage: reply.usage, sinJuicio: true }
  }
}

/* ------------------------------------------------------------------------------ correr */

function parseArgs(argv: string[]) {
  const out: Record<string, string | true> = {}
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg)
    if (m) out[m[1]!] = m[2] ?? true
  }
  return out
}

const TEMPLATES = Object.fromEntries(PRODUCT_RUBROS.map((r) => [r, RUBROS[r].fields])) as Record<
  ProductRubro,
  TemplateField[]
>

async function photosOf(names: string[], copy: "vitrina" | "miniatura"): Promise<PhotoIn[]> {
  const out: PhotoIn[] = []
  for (const name of names) {
    const original = readFileSync(new URL(`fotos/${name}.jpg`, BANK_DIR))
    const copies = await photoCopies(new Uint8Array(original))
    out.push({ ref: name, bytes: copies[copy], contentType: "image/webp" })
  }
  return out
}

const NO_USAGE: Usage = { input: 0, cached: 0, output: 0 }
const add = (a: Usage, b: Usage | null | undefined): Usage =>
  b ? { input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output } : a

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const bank = bankSchema.parse(JSON.parse(readFileSync(new URL("fotos.json", BANK_DIR), "utf8")))
  for (const name of [...bank.casos, ...bank.juntar].flatMap((c) => c.fotos))
    if (!bank.creditos[name]) throw new Error(`La foto ${name} no tiene su crédito en el banco`)
  const only = typeof args.casos === "string" ? new Set(args.casos.split(",")) : null
  const cases = bank.casos.filter((c) => !only || only.has(c.id))
  const groups = bank.juntar.filter((c) => !only || only.has(c.id))
  const reps = Number(args.repeticiones ?? 1)
  const withJudge = !args["sin-juez"]

  if (args.estimar) {
    // Lo de una llamada, por lo medido en las pruebas: unas 1 500 fichas de las reglas, unas 800
    // por foto (vitrina, detalle alto; la miniatura en bajo, unas 100) y unas 800 de respuesta con
    // el razonamiento bajo. El juez, otro tanto con las mismas fotos.
    const photos = cases.reduce((n, c) => n + c.fotos.length, 0)
    const groupPhotos = groups.reduce((n, c) => n + c.fotos.length, 0)
    const calls = (cases.length + groups.length + (withJudge ? cases.length : 0)) * reps
    const input =
      (cases.length * 1_500 + photos * 800 + groups.length * 500 + groupPhotos * 100) *
      reps *
      (withJudge ? 2 : 1)
    const output = calls * 800
    const usd = (input * 0.1 + output * 0.5) / 1e6
    console.log(
      JSON.stringify(
        {
          llamadas: calls,
          fichas_entrada: input,
          fichas_salida: output,
          usd_aprox: Number(usd.toFixed(3)),
          precio: "gpt-6-luna: 0,10 / 0,50 USD por millón",
        },
        null,
        2,
      ),
    )
    return
  }

  const env = process.env
  const model = photosModelFromEnv({
    ...env,
    ...(typeof args.modelo === "string" ? { GESTORIA_FOTOS_MODEL: args.modelo } : {}),
    NODE_ENV: "development",
  })
  if (!model) throw new Error("Falta GESTORIA_OPENAI_API_KEY (o GESTORIA_FOTOS_MODEL=fake)")
  const fake = model.name === "fake"
  const judgeModel =
    fake || !withJudge
      ? null
      : openAIModel({
          apiKey: env.GESTORIA_OPENAI_API_KEY!.trim(),
          model: PHOTOS_MODEL,
          reasoningEffort: "medium",
          timeoutMs: 90_000,
        })

  const runs: unknown[] = []
  let usage = NO_USAGE
  let judgeUsage = NO_USAGE
  const totals = {
    inventados_reglas: 0,
    inventados_juez: 0,
    preguntas_esperadas: 0,
    preguntas_hechas: 0,
    aciertos_posibles: 0,
    aciertos_logrados: 0,
    descartados_por_la_revision: 0,
    fallos: 0,
  }
  for (let rep = 1; rep <= reps; rep++) {
    for (const item of cases) {
      const photos = await photosOf(item.fotos, "vitrina")
      try {
        const look = await lookAtProduct(model, { photos, rubro: null, templates: TEMPLATES })
        usage = add(usage, look.usage)
        const scored = scoreLook(item, look)
        const judged = judgeModel ? await judge(judgeModel, photos, item, look) : null
        judgeUsage = add(judgeUsage, judged?.usage)
        totals.inventados_reglas += scored.inventados.length
        totals.inventados_juez += judged?.inventos.length ?? 0
        totals.preguntas_esperadas += scored.preguntas.esperadas
        totals.preguntas_hechas += scored.preguntas.hechas
        totals.aciertos_posibles += scored.aciertos.posibles
        totals.aciertos_logrados += scored.aciertos.logrados
        totals.descartados_por_la_revision += look.discarded.length
        runs.push({
          caso: item.id,
          repeticion: rep,
          ...scored,
          juez: judged?.inventos ?? null,
          propuesto: look.proposals,
          descartado: look.discarded,
          leido: look.read,
          mismo_producto: look.sameProduct,
          aviso: look.notice,
          costo_usd: (costMicros(look.model, look.usage) ?? 0) / 1e6,
        })
        console.log(
          `${item.id}: ${scored.inventados.length} inventado(s), preguntas ${scored.preguntas.hechas}/${scored.preguntas.esperadas}, aciertos ${scored.aciertos.logrados}/${scored.aciertos.posibles}${judged ? `, juez ${judged.inventos.length}` : ""}`,
        )
      } catch (error) {
        totals.fallos++
        runs.push({ caso: item.id, repeticion: rep, fallo: String(error) })
        console.log(`${item.id}: falló (${String(error)})`)
      }
    }
    for (const item of groups) {
      const photos = await photosOf(item.fotos, "miniatura")
      try {
        const look = await groupLoosePhotos(model, photos)
        usage = add(usage, look.usage)
        const scored = scoreGroups(item, look.proposals)
        totals.inventados_reglas += scored.inventados.length
        totals.aciertos_posibles += scored.aciertos.posibles
        totals.aciertos_logrados += scored.aciertos.logrados
        totals.descartados_por_la_revision += look.discarded.length
        runs.push({ caso: item.id, repeticion: rep, ...scored, propuesto: look.proposals })
        console.log(
          `${item.id}: ${scored.inventados.length} mal juntada(s), pares ${scored.aciertos.logrados}/${scored.aciertos.posibles}`,
        )
      } catch (error) {
        totals.fallos++
        runs.push({ caso: item.id, repeticion: rep, fallo: String(error) })
        console.log(`${item.id}: falló (${String(error)})`)
      }
    }
  }
  const cost = {
    modelo: model.name,
    fichas: usage,
    usd: (costMicros(model.name, usage) ?? 0) / 1e6,
    juez_fichas: judgeUsage,
    juez_usd: (costMicros(PHOTOS_MODEL, judgeUsage) ?? 0) / 1e6,
  }
  const result = {
    modelo: model.name,
    fake,
    repeticiones: reps,
    resumen: totals,
    costo: cost,
    corridas: runs,
  }
  const out =
    typeof args.salida === "string"
      ? args.salida
      : join(
          tmpdir(),
          "gestoria-eval-fotos",
          `fotos-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
        )
  mkdirSync(join(out, ".."), { recursive: true })
  writeFileSync(out, JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ resumen: totals, costo: cost }, null, 2))
  if (fake) console.log("Con el modelo de desarrollo sin red: no cuenta como medición.")
  console.log(`Informe: ${out}`)
}

// Corre solo como comando (`eval:fotos`); las pruebas importan las cuentas.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
  process.exit(0)
}
