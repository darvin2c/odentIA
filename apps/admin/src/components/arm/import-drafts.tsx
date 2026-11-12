/**
 * Lo que deja la skill de carga en la ficha del cliente › Alta (ARM, ADR
 * 0183): el plan de configuración, el de pacientes y el informe, cada uno con
 * su número. La skill solo deposita; aprobar, devolver, ensayar, cargar y
 * enviar es de Administración con su sesión, y el servidor lo exige.
 */
import { toast } from "@odentia/ui"
import { submitErrorMessage } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { z } from "zod"
import { ApiError, api } from "../../lib/api"
import { limaDayWords } from "../../lib/invitation-words"
import { supportDay } from "../../lib/support-words"

export const IMPORT_DRAFT_KINDS = ["plan_configuracion", "plan_pacientes", "informe"] as const
export type ImportDraftKind = (typeof IMPORT_DRAFT_KINDS)[number]

const person = z.object({ userId: z.string(), name: z.string() })

export const importDraftSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  organizationId: z.string(),
  kind: z.enum(IMPORT_DRAFT_KINDS),
  number: z.number(),
  status: z.enum(["lista", "aprobada", "devuelta", "usada"]),
  summary: z.record(z.string(), z.union([z.number(), z.string(), z.null()])).nullable(),
  pdfFileId: z.string().nullable(),
  viaSkill: z.boolean(),
  uploadedBy: person,
  approvedBy: person.nullable(),
  approvedAt: z.string().nullable(),
  returnedNote: z.string().nullable(),
  /** Cuándo se borró su JSON (al cargarse o a los 30 días): ya no se abre. */
  payloadDeletedAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type ImportDraft = z.infer<typeof importDraftSchema>

/** Qué es cada borrador, en palabras. */
export const DRAFT_KIND_WORDS: Record<ImportDraftKind, string> = {
  plan_configuracion: "Plan de configuración",
  plan_pacientes: "Plan de pacientes",
  informe: "Informe a la clínica",
}

/** Las cifras de un borrador, en palabras; lo que no se reconoce no se muestra. */
const SUMMARY_WORDS: Record<string, [string, string]> = {
  sedes: ["sede", "sedes"],
  servicios: ["servicio", "servicios"],
  equipo: ["persona del equipo", "personas del equipo"],
  productos: ["producto", "productos"],
  proveedores: ["proveedor", "proveedores"],
  mediosDePago: ["medio de pago", "medios de pago"],
  consentimientos: ["consentimiento", "consentimientos"],
  formatos: ["formato", "formatos"],
  respuestas: ["respuesta", "respuestas"],
  gastosFijos: ["gasto fijo", "gastos fijos"],
  personas: ["persona", "personas"],
  pacientes: ["paciente", "pacientes"],
  omitidas: ["fila fuera", "filas fuera"],
  archivos: ["archivo", "archivos"],
  hecho: ["cosa hecha", "cosas hechas"],
  usado: ["dato usado", "datos usados"],
  falta: ["cosa por hacer", "cosas por hacer"],
}

export function draftSummaryWords(summary: ImportDraft["summary"]): string {
  if (!summary) return ""
  return Object.entries(summary)
    .flatMap(([key, value]) => {
      const words = SUMMARY_WORDS[key]
      if (!words || typeof value !== "number" || value === 0) return []
      return [`${value} ${value === 1 ? words[0] : words[1]}`]
    })
    .join(" · ")
}

/** «Plan de configuración N.º 2 · lo dejó la skill el jue 12 nov · aprobado por Ada». */
export function draftLine(draft: ImportDraft): string {
  const who = draft.viaSkill
    ? "lo dejó la skill"
    : `lo subió ${draft.uploadedBy.name.split(" ")[0]}`
  const pieces = [
    `${DRAFT_KIND_WORDS[draft.kind]} N.º ${draft.number}`,
    `${who} el ${supportDay(draft.createdAt)}`,
  ]
  if (draft.approvedBy && draft.approvedAt)
    pieces.push(
      `aprobado por ${draft.approvedBy.name.split(" ")[0]} el ${supportDay(draft.approvedAt)}`,
    )
  return pieces.join(" · ")
}

/** Lo que la skill dejó para un cliente, lo último arriba. Solo lo pide Administración. */
export function useImportDrafts(clientId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["admin", "client", clientId, "import-drafts"],
    enabled,
    queryFn: async () =>
      z
        .array(importDraftSchema)
        .parse(await api<unknown>(`/api/admin/clients/${clientId}/import-drafts`)),
  })
}

/**
 * El borrador que una tarjeta de la carga puede tomar en vez de un archivo:
 * el último aprobado de su tipo cuyo JSON sigue guardado. Uno `lista` espera
 * primero el sí arriba, en «La skill dejó…».
 */
export function approvedDraftOf(
  drafts: readonly ImportDraft[] | undefined,
  kind: ImportDraftKind,
): ImportDraft | null {
  return (
    drafts?.find(
      (draft) => draft.kind === kind && draft.status === "aprobada" && !draft.payloadDeletedAt,
    ) ?? null
  )
}

/** Lo que reciben las tarjetas de la carga (#598) para usar lo que dejó la skill. */
export interface DraftSource {
  /** Lo que se dice del borrador: número, quién lo dejó y quién lo aprobó. */
  label: string
  /** El nombre con que la tarjeta lo muestra mientras ensaya y carga. */
  fileName: string
  /** Trae el JSON (deja auditoría en el servidor). */
  load: () => Promise<unknown>
  /** Se cargó o se envió: quien lo ofrece refresca lo suyo. */
  onUsed?: () => void
}

/** Lo que se dice de un borrador cuyo JSON ya no está (se cargó, o pasaron 30 días). */
export const DRAFT_GONE_WORDS = "El archivo ya se borró (30 días)"

/** El servidor dice que el JSON del borrador ya se borró (409 `IMPORT_DRAFT_PAYLOAD_GONE`). */
export const isDraftPayloadGone = (error: unknown): boolean =>
  error instanceof ApiError &&
  error.status === 409 &&
  error.shape.code === "IMPORT_DRAFT_PAYLOAD_GONE"

/** El JSON de un borrador, validado otra vez por el servidor. */
export async function loadDraftPayload(draftId: string): Promise<unknown> {
  const body = z
    .object({ id: z.string(), kind: z.enum(IMPORT_DRAFT_KINDS), payload: z.unknown() })
    .parse(await api<unknown>(`/api/admin/clients/import-drafts/${draftId}/payload`))
  return body.payload
}

/**
 * Se cargó o se envió desde este borrador: pasa a «Ya se usó» y el servidor
 * borra su JSON (trae datos de la clínica y de sus pacientes).
 */
export async function markDraftUsed(draftId: string): Promise<void> {
  await api(`/api/admin/clients/import-drafts/${draftId}/used`, { method: "POST" })
}

/**
 * Lo que recibe la tarjeta de un borrador aprobado. Al terminar de cargarlo o
 * de enviarlo se anota que se usó; si eso falla se dice, sin deshacer la
 * carga (la pasada de Kairós lo verá igual como un plan sin cargar).
 */
export function draftSourceOf(
  draft: ImportDraft | null,
  onChanged?: () => void,
): DraftSource | undefined {
  if (!draft) return undefined
  return {
    label: draftLine(draft),
    fileName: `${DRAFT_KIND_WORDS[draft.kind]} N.º ${draft.number} de la skill`,
    load: async () => {
      if (draft.payloadDeletedAt)
        throw new Error(`${DRAFT_GONE_WORDS}: pide a la skill que deje otro`)
      try {
        return await loadDraftPayload(draft.id)
      } catch (error) {
        if (!isDraftPayloadGone(error)) throw error
        // Se borró mientras la pantalla estaba abierta: la lista se refresca y ya no se ofrece.
        onChanged?.()
        throw new Error(`${DRAFT_GONE_WORDS}: pide a la skill que deje otro`)
      }
    },
    onUsed: () =>
      void markDraftUsed(draft.id)
        .catch((error: unknown) =>
          isDraftPayloadGone(error)
            ? toast.info(`${DRAFT_GONE_WORDS}. Lo que se cargó quedó cargado.`)
            : toast.error(
                `Se hizo, pero no se anotó que el ${DRAFT_KIND_WORDS[draft.kind].toLowerCase()} N.º ${draft.number} se usó: ${submitErrorMessage(error)}`,
              ),
        )
        .finally(() => onChanged?.()),
  }
}

/** «se borra el jue 12 dic» de un día de Lima. */
export const deleteOnWords = (day: string): string => `se borra el ${limaDayWords(day)}`
