import { TREATMENT_KIND_KEYS, TREATMENT_SCOPES, validateLeavesFinding } from "@odentia/dental"
import { and, eq, inArray, notInArray, sql } from "drizzle-orm"
import type { Db } from "../client.js"
import { type CatalogLibrary, type ProcedureLists, seedProcedureCodes, splitHead, strictLines } from "../procedure-codes.js"
import { treatmentTemplate } from "../schema/clinical.js"

/**
 * La biblioteca de odentIA (ADR 0069 y 0079): `seeds/biblioteca.csv`,
 * tratamientos de consultorio con nombre propio, tipo, ámbito, lo que dejan en
 * la pieza, si van en «Más usados» y si son la variante de una norma que solo
 * se ofrece donde tiene código; `seeds/biblioteca_codigos.csv`, el código de
 * cada uno en cada lista. Lo que ya no está queda inactivo (las plantillas
 * `cpms:` de antes); las filas se conservan para los servicios que las usan.
 */
export const dentalLibrary: CatalogLibrary = {
  product: "dental",
  prepare(lists: ProcedureLists) {
    const SCOPES: ReadonlySet<string> = new Set(TREATMENT_SCOPES)
    const KINDS: ReadonlySet<string> = new Set(TREATMENT_KIND_KEYS)
    const templates = strictLines(
      "biblioteca.csv",
      "key,kind,scope,surface_count_min,surface_count_max,leaves_condition,leaves_variant,common,coded_only,name",
    ).map((line) => {
      const [key, kind, scope, minRaw, maxRaw, condition, variant, common, codedOnly, name] = splitHead(line, 10)
      const min = minRaw === "" ? null : Number(minRaw)
      const max = maxRaw === "" ? null : Number(maxRaw)
      if (
        !key ||
        !/^[a-z0-9-]+$/.test(key) ||
        !KINDS.has(kind!) ||
        !SCOPES.has(scope!) ||
        !name ||
        (common !== "true" && common !== "false") ||
        (codedOnly !== "true" && codedOnly !== "false") ||
        (minRaw !== "" && !Number.isInteger(min)) ||
        (maxRaw !== "" && !Number.isInteger(max))
      ) {
        throw new Error(`Línea inválida en biblioteca.csv: ${line}`)
      }
      if (scope === "surfaces" && (min === null || max === null || min < 1 || min > max)) {
        throw new Error(`Scope surfaces sin conteo válido: ${line}`)
      }
      if (scope !== "surfaces" && (min !== null || max !== null)) {
        throw new Error(`Conteo fuera de scope surfaces: ${line}`)
      }
      if (!condition && variant) throw new Error(`Variante sin hallazgo: ${line}`)
      const leaves = condition ? (variant ? { condition, variant } : { condition }) : null
      // Lo que deja en la pieza encaja con el ámbito; la variante, si va, existe.
      if (leaves && validateLeavesFinding(leaves, { scope, strictVariants: false }).length > 0) {
        throw new Error(`Lo que deja en la pieza no encaja: ${line}`)
      }
      return { key, kind: kind!, scope: scope!, min, max, leaves, common: common === "true", codedOnly: codedOnly === "true", name }
    })

    // --- Código de cada tratamiento en cada lista ---
    const mappings = strictLines("biblioteca_codigos.csv", "template_key,system_key,code,version").map(
      (line) => {
        const [templateKey, systemKey, code, version] = splitHead(line, 4)
        if (!templateKey || !systemKey || !code || !version) {
          throw new Error(`Línea inválida en biblioteca_codigos.csv: ${line}`)
        }
        return { templateKey, systemKey, code, version }
      },
    )

    // --- Validación cruzada de la biblioteca (antes de tocar la DB) ---
    if (new Set(templates.map((t) => t.key)).size !== templates.length) {
      throw new Error("Tratamientos duplicados en biblioteca.csv")
    }
    if (new Set(templates.map((t) => t.name.toLowerCase())).size !== templates.length) {
      throw new Error("Nombres repetidos en biblioteca.csv")
    }
    const coded = new Set(mappings.map((m) => m.templateKey))
    for (const t of templates) {
      if (t.codedOnly && !coded.has(t.key)) throw new Error(`Variante sin código en ninguna lista: ${t.key}`)
    }
    const releaseOf = new Map(lists.releases.map((r) => [r.systemKey, r]))
    const { codeSets } = lists
    const templateKeys = new Set(templates.map((t) => t.key))
    const perList = new Set<string>()
    for (const m of mappings) {
      if (!templateKeys.has(m.templateKey)) throw new Error(`Código de un tratamiento que no está: ${m.templateKey}`)
      if (releaseOf.get(m.systemKey)?.version !== m.version) {
        throw new Error(`Código fuera de la edición vigente: ${m.templateKey} ${m.systemKey} ${m.version}`)
      }
      if (!codeSets.get(m.systemKey)!.has(m.code)) {
        throw new Error(`Código inexistente en la lista: ${m.systemKey} ${m.code} ${m.version}`)
      }
      const list = `${m.templateKey}:${m.systemKey}`
      if (perList.has(list)) throw new Error(`Dos códigos de la misma lista para ${m.templateKey}`)
      perList.add(list)
    }

    const scopeKeys = templates.map((t) => t.key)
    return {
      keys: scopeKeys,
      templates: templates.length,
      mappings: (system: string) => mappings.filter((m) => m.systemKey === system).length,
      async seed(tx: Db) {
        for (const t of templates) {
          // Lo dental del tratamiento (caras y lo que deja en la pieza) va en
          // `dental_template_rule` (ADR 0079); cambiarlo también sube la versión.
          const rule = sql`row(${t.min}::int, ${t.max}::int, ${t.leaves?.condition ?? null}::text, ${t.leaves?.variant ?? null}::text)::text`
          const storedRule = sql`coalesce((select row(r."surface_count_min", r."surface_count_max", r."leaves_condition", r."leaves_variant")::text
            from "dental_template_rule" r where r."template_id" = "treatment_template"."id"), row(null::int, null::int, null::text, null::text)::text)`
          await tx.execute(
            sql`insert into "treatment_template"
            ("key", "name", "specialty", "scope", "product", "is_common", "coded_only", "is_active", "version")
            values (${t.key}, ${t.name}, ${t.kind}, ${t.scope}, 'dental', ${t.common}, ${t.codedOnly}, true, 1)
            on conflict ("key") do update set
              "name" = excluded."name",
              "specialty" = excluded."specialty",
              "scope" = excluded."scope",
              "product" = excluded."product",
              "is_common" = excluded."is_common",
              "coded_only" = excluded."coded_only",
              "is_active" = true,
              "version" = "treatment_template"."version" + (
                ("treatment_template"."name", "treatment_template"."specialty", "treatment_template"."scope", ${storedRule})
                IS DISTINCT FROM
                (excluded."name", excluded."specialty", excluded."scope", ${rule})
              )::int`,
          )
          if (t.min === null && t.max === null && !t.leaves) {
            await tx.execute(
              sql`delete from "dental_template_rule" where "template_id" = (select "id" from "treatment_template" where "key" = ${t.key})`,
            )
          } else {
            await tx.execute(
              sql`insert into "dental_template_rule" ("template_id", "surface_count_min", "surface_count_max", "leaves_condition", "leaves_variant")
              select "id", ${t.min}, ${t.max}, ${t.leaves?.condition ?? null}, ${t.leaves?.variant ?? null} from "treatment_template" where "key" = ${t.key}
              on conflict ("template_id") do update set
                "surface_count_min" = excluded."surface_count_min",
                "surface_count_max" = excluded."surface_count_max",
                "leaves_condition" = excluded."leaves_condition",
                "leaves_variant" = excluded."leaves_variant"`,
            )
          }
        }
        // Lo que ya no está en la biblioteca (las plantillas `cpms:` de antes)
        // queda inactivo; las filas se conservan para los servicios que las usan.
        // Solo lo de odentIA: la biblioteca de latidIA se siembra aparte.
        await tx
          .update(treatmentTemplate)
          .set({ isActive: false })
          .where(and(eq(treatmentTemplate.product, "dental"), notInArray(treatmentTemplate.key, scopeKeys)))
        // El código de cada tratamiento en cada edición se reemplaza entero: un
        // cambio de código en el CSV no deja el viejo. Otras ediciones no se tocan.
        const own = sql`(select "id" from "treatment_template" where "product" = 'dental')`
        for (const release of lists.releases) {
          await tx.execute(
            sql`delete from "treatment_template_code"
              where "system_key" = ${release.systemKey} and "version" = ${release.version} and "template_id" in ${own}`,
          )
        }
        for (const m of mappings) {
          await tx.execute(
            sql`insert into "treatment_template_code" ("template_id", "system_key", "code", "version")
              select "id", ${m.systemKey}, ${m.code}, ${m.version} from "treatment_template" where "key" = ${m.templateKey}`,
          )
        }

        // Conciliación dentro de la transacción: cobertura exacta o rollback.
        const [active] = (await tx.execute(
          sql`select count(*)::int as count from "treatment_template" where ${inArray(sql`"key"`, scopeKeys)} and "is_active"`,
        )) as unknown as { count: number }[]
        if (active?.count !== templates.length) {
          throw new Error(`Conciliación falló (templates): ${active?.count} frente a ${templates.length}`)
        }
      },
    }
  },
}

/** El catálogo de odentIA entero: las listas oficiales y su biblioteca, en una transacción. */
export function seedOdentiaCatalog(db: Db) {
  return seedProcedureCodes(db, dentalLibrary)
}
