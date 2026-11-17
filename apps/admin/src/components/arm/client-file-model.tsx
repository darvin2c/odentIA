/**
 * Los documentos de un cliente del ARM (ficha › Documentos, ADR 0185 y 0196) como los lee la
 * administración: su esquema, sus palabras, las direcciones para descargarlos y verlos, y «Es la
 * carga de datos». Lo usan Documentos, el visor, Alta, el correo y los chats.
 */
import { toast } from "@odentia/ui"
import { ConfirmDialog, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { z } from "zod"
import { api } from "../../lib/api"
import { API_URL } from "../../lib/auth-client"
import { limaDayWords } from "../../lib/invitation-words"
import { invalidateClient } from "./client-model"

export const CLIENT_FILE_KINDS = [
  "carta",
  "propuesta",
  "presentacion",
  "archivo_clinica",
  "correo",
  "otro",
] as const
export type ClientFileKind = (typeof CLIENT_FILE_KINDS)[number]

export const FILE_KIND_WORDS: Record<ClientFileKind, string> = {
  carta: "Carta de bienvenida",
  propuesta: "Propuesta",
  presentacion: "Presentación",
  archivo_clinica: "Lo que mandó la clínica",
  correo: "Adjunto de un correo",
  otro: "Otro",
}

/** De dónde vino: una persona del equipo, Kairós, un correo o un chat (`SAAS_CLIENT_FILE_SOURCES`). */
export const CLIENT_FILE_SOURCES = [
  "persona",
  "kairos",
  "correo",
  "whatsapp",
  "instagram",
  "messenger",
] as const
export type ClientFileSource = (typeof CLIENT_FILE_SOURCES)[number]

/** Por dónde llegó lo que mandó la clínica. */
export const ARRIVED_BY_WORDS: Record<"correo" | "whatsapp" | "instagram" | "messenger", string> = {
  correo: "por correo",
  whatsapp: "por WhatsApp",
  instagram: "por Instagram",
  messenger: "por Messenger",
}

const fileSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  kind: z.enum(CLIENT_FILE_KINDS),
  filename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number(),
  adminOnly: z.boolean(),
  deleteAfter: z.string().nullable(),
  // Un origen que no se conoce se lee como sin origen: un valor nuevo no rompe la pestaña.
  source: z.enum(CLIENT_FILE_SOURCES).nullable().catch(null),
  createdAt: z.string(),
  createdBy: z.object({ userId: z.string(), name: z.string() }).nullable(),
  /** Cuándo llegó (la hora del correo o del mensaje si vino así). */
  receivedAt: z.string().nullable().default(null),
  cargaAt: z.string().nullable().default(null),
  inboundEmailId: z.string().nullable().default(null),
  /** En un adjunto: el día en que se borraría si se marca ahora como la carga (lo dice el servidor). */
  cargaDeleteAfter: z.string().nullable().default(null),
  /** Marcarlo ahora lo borra en el acto. */
  cargaDueNow: z.boolean().default(false),
})
export type ClientFile = z.infer<typeof fileSchema>

const filesSchema = z.object({
  items: z.array(fileSchema),
  agreement: z
    .object({ version: z.string(), acceptedAt: z.string(), acceptedBy: z.string().nullable() })
    .nullable(),
})

export const clientFilesKey = (clientId: string) => ["admin", "client", clientId, "files"] as const

/** Los documentos vigentes del cliente (los que quien mira puede ver). */
export function useClientFiles(clientId: string, enabled = true) {
  return useQuery({
    queryKey: clientFilesKey(clientId),
    enabled,
    queryFn: async () =>
      filesSchema.parse(await api<unknown>(`/api/admin/clients/${clientId}/files`)),
  })
}

/** Lo que se puede subir: lo mismo que entra por correo (el servidor lo revisa por sus bytes). */
export const CLIENT_FILE_ACCEPT =
  "application/pdf,image/jpeg,image/png,image/webp,image/gif,.xlsx,.docx,.csv,text/csv"
export const CLIENT_FILE_TYPES_HINT = "PDF, imagen, Excel, CSV o Word; hasta 10 MB"

const enc = encodeURIComponent

/** El enlace de descarga: la API responde con la dirección firmada de 15 minutos y deja auditoría. */
export const clientFileHref = (fileId: string) =>
  `${API_URL}/api/admin/clients/files/${enc(fileId)}`
/** Para ver una imagen: la API responde con una dirección de 5 minutos, para verse. */
export const clientFilePreviewHref = (fileId: string) =>
  `${API_URL}/api/admin/clients/files/${enc(fileId)}/preview`
/** Los bytes de un PDF para dibujarlo (`fetchPdfBytes`). */
export const clientFileContentPath = (fileId: string) =>
  `/api/admin/clients/files/${enc(fileId)}/content`
/** El PDF de un informe de la carga (solo Administración). */
export const clientReportContentPath = (clientId: string, number: number) =>
  `/api/admin/clients/${enc(clientId)}/reports/${number}/content`

/** Lo que tiene vista en la ficha: las imágenes y el PDF (lo mismo que acepta el servidor). */
const PREVIEW_TYPES: Record<string, "imagen" | "pdf"> = {
  "image/jpeg": "imagen",
  "image/png": "imagen",
  "image/gif": "imagen",
  "image/webp": "imagen",
  "application/pdf": "pdf",
}
/** Hasta este tamaño se dibuja un PDF en la ficha (`CLIENT_FILE_CONTENT_MAX_BYTES`). */
export const PDF_VIEW_MAX_BYTES = 10 * 1024 * 1024

export function previewKindOf(file: Pick<ClientFile, "contentType" | "sizeBytes">) {
  const kind = PREVIEW_TYPES[file.contentType.trim().toLowerCase()] ?? null
  return kind === "pdf" && file.sizeBytes > PDF_VIEW_MAX_BYTES ? null : kind
}

export const sizeWords = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${new Intl.NumberFormat("es-PE", { maximumFractionDigits: 1 }).format(bytes / (1024 * 1024))} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`

/** Llegó de la clínica: por correo o un chat, o lo que se subió como lo que mandó. */
export function cameFromClinic(file: Pick<ClientFile, "kind" | "source">): boolean {
  return (
    file.kind === "archivo_clinica" ||
    file.kind === "correo" ||
    file.source === "correo" ||
    file.source === "whatsapp" ||
    file.source === "instagram" ||
    file.source === "messenger"
  )
}

/** Quién lo dejó, en palabras. */
export function whoWords(file: ClientFile): string {
  const name = file.createdBy?.name.split(" ")[0]
  if (file.source === "kairos") return "lo dejó Kairós"
  if (
    file.source === "correo" ||
    file.source === "whatsapp" ||
    file.source === "instagram" ||
    file.source === "messenger"
  )
    return `llegó ${ARRIVED_BY_WORDS[file.source]}`
  return name ? `lo subió ${name}` : "lo subió el equipo"
}

/** El día en que llegó o se subió: la hora del correo o del mensaje si vino así. */
export const fileDay = (file: ClientFile): string =>
  file.source !== "persona" && file.source !== "kairos" && file.receivedAt
    ? file.receivedAt
    : file.createdAt

/** «se borra el jue 12 dic» de un día de Lima. */
export const deleteOnWords = (day: string): string => `se borra el ${limaDayWords(day)}`

/** Lo que se marca como la carga: un adjunto, con el plazo que dijo el servidor. */
export interface CargaCandidate {
  fileId: string
  filename: string
  cargaDeleteAfter: string | null
  cargaDueNow: boolean
}

/** Lo que dice el diálogo de «Es la carga de datos» antes de marcarlo. */
export function cargaConfirmWords(file: CargaCandidate): string {
  if (file.cargaDueNow || !file.cargaDeleteAfter)
    return `${file.filename} llegó hace más de 30 días: se borra al marcarlo, con el texto del correo en que llegó, como promete el contrato de encargo. No se puede deshacer.`
  return `${file.filename} pasa a «Lo que mandó la clínica» y se borra el ${limaDayWords(file.cargaDeleteAfter)}, a los 30 días de llegar, con el texto del correo en que llegó. Lo promete el contrato de encargo. No se puede deshacer.`
}

export const markCargaResultSchema = z.object({
  file: z.object({ id: z.string(), deleteAfter: z.string().nullable() }),
  dueNow: z.boolean(),
  deletedNow: z.boolean(),
})
export type MarkCargaResult = z.infer<typeof markCargaResultSchema>

/** Lo que dice el aviso al terminar de marcarlo. */
export function cargaMarkedWords(filename: string, result: MarkCargaResult): string {
  if (result.deletedNow) return `${filename} se borró: llegó hace más de 30 días`
  if (result.dueNow) return `${filename} es la carga de datos: se borra en los próximos minutos`
  return result.file.deleteAfter
    ? `${filename} es la carga de datos: ${deleteOnWords(result.file.deleteAfter)}`
    : `${filename} es la carga de datos`
}

/**
 * «Es la carga de datos» (solo Administración): pregunta con la fecha que dice
 * el servidor y marca. Lo usan Documentos, el visor, Alta, el correo y los chats. Devuelve
 * `ask`, que abre el diálogo, y `dialog`, para ponerlo en la pantalla. La confirmación se
 * justifica: es un borrado de datos que no se deshace.
 */
export function useMarkCarga(clientId: string | null, onDone?: () => void) {
  const queryClient = useQueryClient()
  const [target, setTarget] = useState<CargaCandidate | null>(null)
  const mark = useMutation({
    mutationFn: async (file: CargaCandidate) =>
      markCargaResultSchema.parse(
        await api<unknown>(`/api/admin/clients/files/${file.fileId}/carga`, { method: "POST" }),
      ),
    onSuccess: (result, file) => {
      toast.success(cargaMarkedWords(file.filename, result))
      setTarget(null)
      if (clientId) invalidateClient(queryClient, clientId)
      onDone?.()
    },
  })
  const dialog = (
    <ConfirmDialog
      open={target !== null}
      title="¿Es la carga de datos?"
      description={target ? cargaConfirmWords(target) : ""}
      confirmLabel="Sí, es la carga"
      pending={mark.isPending}
      error={mark.isError ? submitErrorMessage(mark.error) : null}
      onConfirm={() => {
        if (target) mark.mutate(target)
      }}
      onClose={() => {
        mark.reset()
        setTarget(null)
      }}
    />
  )
  return { ask: setTarget, dialog }
}
