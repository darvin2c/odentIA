import { MEDICAL_SERVICE_KIND_KEYS } from "@odentia/medical"
import { and, eq, inArray, notInArray, sql } from "drizzle-orm"
import type { Db } from "../client.js"
import {
  type CatalogLibrary,
  type ProcedureLists,
  splitHead,
  strictLines,
} from "../procedure-codes.js"
import { treatmentTemplate } from "../schema/clinical.js"

/**
 * La biblioteca de latidIA (issue 229, entrega 8): `seeds/biblioteca_medica.csv`,
 * los servicios de un consultorio de atención primaria con nombre propio, su
 * tipo y si van en «Más usados»; `seeds/biblioteca_medica_codigos.csv`, el
 * código de cada uno en cada lista. Todo es de ámbito general: la parte del
 * cuerpo se escribe (decisión 4). Solo toca lo suyo (`product = 'medical'`):
 * la biblioteca de odentIA se siembra en la misma transacción.
 */
export const medicalLibrary: CatalogLibrary = {
  product: "medical",
  prepare(lists: ProcedureLists) {
    const KINDS: ReadonlySet<string> = new Set(MEDICAL_SERVICE_KIND_KEYS)
    const templates = strictLines("biblioteca_medica.csv", "key,kind,common,name").map((line) => {
      const [key, kind, common, name] = splitHead(line, 4)
      if (
        !key ||
        !/^[a-z0-9-]+$/.test(key) ||
        !KINDS.has(kind!) ||
        !name ||
        (common !== "true" && common !== "false")
      ) {
        throw new Error(`Línea inválida en biblioteca_medica.csv: ${line}`)
      }
      return { key, kind: kind!, common: common === "true", name }
    })
    const mappings = strictLines(
      "biblioteca_medica_codigos.csv",
      "template_key,system_key,code,version",
    ).map((line) => {
      const [templateKey, systemKey, code, version] = splitHead(line, 4)
      if (!templateKey || !systemKey || !code || !version) {
        throw new Error(`Línea inválida en biblioteca_medica_codigos.csv: ${line}`)
      }
      return { templateKey, systemKey, code, version }
    })

    // --- Validación cruzada (antes de tocar la base) ---
    if (new Set(templates.map((t) => t.key)).size !== templates.length) {
      throw new Error("Servicios duplicados en biblioteca_medica.csv")
    }
    if (new Set(templates.map((t) => t.name.toLowerCase())).size !== templates.length) {
      throw new Error("Nombres repetidos en biblioteca_medica.csv")
    }
    const releaseOf = new Map(lists.releases.map((r) => [r.systemKey, r]))
    const keys = new Set(templates.map((t) => t.key))
    const perList = new Set<string>()
    for (const m of mappings) {
      if (!keys.has(m.templateKey))
        throw new Error(`Código de un servicio que no está: ${m.templateKey}`)
      if (releaseOf.get(m.systemKey)?.version !== m.version) {
        throw new Error(
          `Código fuera de la edición vigente: ${m.templateKey} ${m.systemKey} ${m.version}`,
        )
      }
      if (!lists.codeSets.get(m.systemKey)!.has(m.code)) {
        throw new Error(`Código inexistente en la lista: ${m.systemKey} ${m.code} ${m.version}`)
      }
      const list = `${m.templateKey}:${m.systemKey}`
      if (perList.has(list)) throw new Error(`Dos códigos de la misma lista para ${m.templateKey}`)
      perList.add(list)
    }

    const ownKeys = templates.map((t) => t.key)
    const ours = eq(treatmentTemplate.product, "medical")
    return {
      keys: ownKeys,
      templates: templates.length,
      mappings: (system: string) => mappings.filter((m) => m.systemKey === system).length,
      async seed(tx: Db) {
        for (const t of templates) {
          await tx.execute(
            sql`insert into "treatment_template"
            ("key", "name", "specialty", "scope", "product", "is_common", "coded_only", "is_active", "version")
            values (${t.key}, ${t.name}, ${t.kind}, 'general', 'medical', ${t.common}, false, true, 1)
            on conflict ("key") do update set
              "name" = excluded."name",
              "specialty" = excluded."specialty",
              "scope" = excluded."scope",
              "product" = excluded."product",
              "is_common" = excluded."is_common",
              "coded_only" = excluded."coded_only",
              "is_active" = true,
              "version" = "treatment_template"."version" + (
                ("treatment_template"."name", "treatment_template"."specialty", "treatment_template"."scope")
                IS DISTINCT FROM (excluded."name", excluded."specialty", excluded."scope")
              )::int`,
          )
        }
        // Lo que ya no está en su biblioteca queda inactivo; las filas se
        // conservan para los servicios que las usan.
        await tx
          .update(treatmentTemplate)
          .set({ isActive: false })
          .where(and(ours, notInArray(treatmentTemplate.key, ownKeys)))
        // Sus códigos en cada edición vigente se reemplazan enteros.
        const own = sql`(select "id" from "treatment_template" where "product" = 'medical')`
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
        const active = await tx
          .select({ id: treatmentTemplate.id })
          .from(treatmentTemplate)
          .where(
            and(
              ours,
              inArray(treatmentTemplate.key, ownKeys),
              eq(treatmentTemplate.isActive, true),
            ),
          )
        if (active.length !== templates.length) {
          throw new Error(
            `Conciliación falló (servicios médicos): ${active.length} frente a ${templates.length}`,
          )
        }
      },
    }
  },
}
