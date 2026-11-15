/**
 * Los documentos que van adjuntos a una respuesta: se eligen de Documentos
 * del cliente o se suben desde el equipo (y quedan en Documentos, aunque la
 * respuesta no salga). Hasta 5 y 10 MB juntos; el servidor lo vuelve a
 * revisar (`REPLY_FILES_MAX`, el tipo real de cada archivo).
 */
import { Button, toast } from "@odentia/ui"
import { submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Paperclip, Upload, X } from "lucide-react"
import { useId, useRef } from "react"
import { z } from "zod"
import { api } from "../../lib/api"
import {
  CLIENT_FILE_ACCEPT,
  CLIENT_FILE_TYPES_HINT,
  type ClientFile,
  clientFilesKey,
  useClientFiles,
} from "./client-files-tab"

export const REPLY_FILES_MAX = 5
export const REPLY_FILES_MAX_BYTES = 10 * 1024 * 1024

const sizeWords = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${new Intl.NumberFormat("es-PE", { maximumFractionDigits: 1 }).format(bytes / (1024 * 1024))} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`

/** Lo que falta corregir en los adjuntos elegidos, o null si se pueden enviar. */
export function replyFilesProblem(chosen: readonly Pick<ClientFile, "sizeBytes">[]): string | null {
  if (chosen.length > REPLY_FILES_MAX) return `Adjunta como máximo ${REPLY_FILES_MAX} documentos`
  const total = chosen.reduce((sum, file) => sum + file.sizeBytes, 0)
  return total > REPLY_FILES_MAX_BYTES ? "Los adjuntos pasan de 10 MB juntos: quita alguno" : null
}

export function ReplyFiles({
  clientId,
  isAdmin,
  value,
  onChange,
  error,
}: {
  clientId: string
  isAdmin: boolean
  value: readonly string[]
  onChange: (ids: string[]) => void
  error?: string | null
}) {
  const queryClient = useQueryClient()
  const files = useClientFiles(clientId)
  const input = useRef<HTMLInputElement>(null)
  const pickId = useId()
  const all = files.data?.items ?? []
  const chosen = value.flatMap((id) => all.filter((file) => file.id === id))
  const free = all.filter((file) => !value.includes(file.id))
  const full = value.length >= REPLY_FILES_MAX
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData()
      body.append("file", file, file.name)
      body.append("kind", "otro")
      body.append("adminOnly", String(isAdmin))
      return z
        .object({ id: z.string() })
        .parse(await api<unknown>(`/api/admin/clients/${clientId}/files`, { method: "POST", body }))
    },
    onSuccess: async (row, file) => {
      await queryClient.invalidateQueries({ queryKey: clientFilesKey(clientId) })
      onChange([...value, row.id])
      toast.success(`${file.name} quedó en Documentos y va adjunto`)
    },
    onError: (failure) => toast.error(submitErrorMessage(failure)),
  })
  const problem = error ?? replyFilesProblem(chosen)
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">Adjuntos (opcional)</legend>
      {chosen.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {chosen.map((file) => (
            <li
              key={file.id}
              className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm"
            >
              <Paperclip aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate" title={file.filename}>
                {file.filename}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {sizeWords(file.sizeBytes)}
              </span>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Quitar ${file.filename}`}
                onClick={() => onChange(value.filter((id) => id !== file.id))}
              >
                <X aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={pickId} className="sr-only">
          Elegir de Documentos
        </label>
        <select
          id={pickId}
          className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm disabled:opacity-50"
          value=""
          disabled={full || free.length === 0}
          onChange={(event) => {
            if (event.target.value) onChange([...value, event.target.value])
          }}
        >
          <option value="">
            {files.isPending
              ? "Cargando sus documentos…"
              : files.isError
                ? "No pude traer sus documentos"
                : free.length === 0
                  ? "No tiene más documentos"
                  : "Elegir de Documentos…"}
          </option>
          {free.map((file) => (
            <option key={file.id} value={file.id}>
              {file.filename} · {sizeWords(file.sizeBytes)}
            </option>
          ))}
        </select>
        <input
          ref={input}
          type="file"
          className="hidden"
          accept={CLIENT_FILE_ACCEPT}
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ""
            if (file) upload.mutate(file)
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={full || upload.isPending}
          onClick={() => input.current?.click()}
        >
          <Upload aria-hidden />
          {upload.isPending ? "Subiendo…" : "Subir un archivo"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {CLIENT_FILE_TYPES_HINT}. Hasta {REPLY_FILES_MAX} documentos y 10 MB juntos. Lo que subes
        queda en Documentos del cliente.
      </p>
      {problem ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
    </fieldset>
  )
}
