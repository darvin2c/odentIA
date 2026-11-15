/**
 * Ficha del cliente › Documentos (ARM, ADR 0185): lo que le mandamos (carta,
 * propuestas, presentaciones) y lo que nos mandó la clínica, con su tipo, quién lo dejó, cuándo y, si lo hay, el día en
 * que se borra. Lo que manda la clínica es solo de Administración; se borra a
 * los 30 días solo lo de la carga de datos (lo promete el contrato de encargo):
 * lo que se sube como «Lo que mandó la clínica» y lo que llegó a soporte@ con
 * adjuntos. Lo demás se guarda. Soporte no ve lo que es
 * solo de Administración y la API tampoco se lo da. Borrar es de
 * Administración.
 */
import { Badge, Button, Input, toast } from "@odentia/ui"
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  FormDrawer,
  SkeletonRegion,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Download, Upload } from "lucide-react"
import { useState } from "react"
import { z } from "zod"
import { api } from "../../lib/api"
import { API_URL } from "../../lib/auth-client"
import { limaDayWords } from "../../lib/invitation-words"
import { supportDay } from "../../lib/support-words"
import { ClientFilesSkeleton } from "../skeletons/client-account"
import type { ClientTabProps } from "./account-tabs"
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

/** Lo que solo maneja Administración (lo que trae datos de la clínica); el servidor lo exige. */
const ADMIN_KINDS: ReadonlySet<ClientFileKind> = new Set(["archivo_clinica", "correo"])
/** Lo de la carga que se sube a mano: solo de Administración y se borra a los 30 días. */
const CLINIC_SENT: ReadonlySet<ClientFileKind> = new Set(["archivo_clinica"])

const fileSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  kind: z.enum(CLIENT_FILE_KINDS),
  filename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number(),
  adminOnly: z.boolean(),
  deleteAfter: z.string().nullable(),
  source: z.enum(["persona", "kairos", "correo"]).nullable(),
  createdAt: z.string(),
  createdBy: z.object({ userId: z.string(), name: z.string() }).nullable(),
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

/** El enlace de descarga: la API responde con la dirección firmada de 15 minutos y deja auditoría. */
export const clientFileHref = (fileId: string) => `${API_URL}/api/admin/clients/files/${fileId}`

const sizeWords = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${new Intl.NumberFormat("es-PE", { maximumFractionDigits: 1 }).format(bytes / (1024 * 1024))} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`

/** Quién lo dejó, en palabras. */
function whoWords(file: ClientFile): string {
  const name = file.createdBy?.name.split(" ")[0]
  if (file.source === "kairos") return "lo dejó Kairós"
  if (file.source === "correo") return "llegó por correo"
  return name ? `lo subió ${name}` : "lo subió el equipo"
}

/** «se borra el jue 12 dic» de un día de Lima. */
const deleteOnWords = (day: string): string => `se borra el ${limaDayWords(day)}`

export function ClientFilesTab({ clientId, isAdmin }: ClientTabProps) {
  const queryClient = useQueryClient()
  const [uploading, setUploading] = useState(false)
  const [toDelete, setToDelete] = useState<ClientFile | null>(null)
  const files = useClientFiles(clientId)
  const remove = useMutation({
    mutationFn: (file: ClientFile) =>
      api(`/api/admin/clients/files/${file.id}`, { method: "DELETE" }),
    onSuccess: (_, file) => {
      toast.success(`Se borró ${file.filename}`)
      setToDelete(null)
      invalidateClient(queryClient, clientId)
    },
  })

  if (files.isPending)
    return (
      <SkeletonRegion message="Cargando los documentos…">
        <ClientFilesSkeleton />
      </SkeletonRegion>
    )

  return (
    <section aria-labelledby="documentos" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="documentos" className="text-base font-semibold">
          Documentos
        </h2>
        <Button type="button" size="sm" variant="outline" onClick={() => setUploading(true)}>
          <Upload aria-hidden />
          Subir
        </Button>
      </div>
      {files.isError ? (
        <ErrorState
          title="No se pudieron cargar los documentos"
          message={submitErrorMessage(files.error)}
          onRetry={() => void files.refetch()}
        />
      ) : (
        <>
          {files.data.agreement ? (
            <p className="text-sm text-muted-foreground">
              Contrato de encargo: aceptó la versión del {files.data.agreement.version} el{" "}
              {supportDay(files.data.agreement.acceptedAt)}
              {files.data.agreement.acceptedBy ? `, ${files.data.agreement.acceptedBy}` : ""}. Se
              lee de su cuenta, no se guarda como archivo.
            </p>
          ) : null}
          {files.data.items.length === 0 ? (
            <EmptyState
              title="Sin documentos"
              description="Aquí quedan la carta de bienvenida, las propuestas, las presentaciones y lo que mande la clínica."
              actionLabel="Subir un documento"
              onAction={() => setUploading(true)}
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {files.data.items.map((file) => (
                <li
                  key={file.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-card p-4"
                >
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      <span className="[overflow-wrap:anywhere]">{file.filename}</span>
                      {file.adminOnly ? <Badge variant="outline">Solo Administración</Badge> : null}
                    </p>
                    <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      {FILE_KIND_WORDS[file.kind]} · {whoWords(file)} el{" "}
                      {supportDay(file.createdAt)} · {sizeWords(file.sizeBytes)}
                      {file.deleteAfter ? ` · ${deleteOnWords(file.deleteAfter)}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      render={<a href={clientFileHref(file.id)} target="_blank" rel="noreferrer" />}
                    >
                      <Download aria-hidden />
                      Descargar
                    </Button>
                    {isAdmin ? (
                      <Button size="sm" variant="ghost" onClick={() => setToDelete(file)}>
                        Borrar
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {uploading ? (
        <ClientFileUploadDrawer
          clientId={clientId}
          isAdmin={isAdmin}
          onClose={() => setUploading(false)}
        />
      ) : null}
      <ConfirmDialog
        open={toDelete !== null}
        title={toDelete ? `Borrar ${toDelete.filename}` : "Borrar el documento"}
        description="Deja de verse en la ficha y se borra del almacenamiento. Queda anotado quién lo borró. No se puede deshacer."
        confirmLabel="Borrar"
        pending={remove.isPending}
        error={remove.isError ? submitErrorMessage(remove.error) : null}
        onConfirm={() => {
          if (toDelete) remove.mutate(toDelete)
        }}
        onClose={() => {
          remove.reset()
          setToDelete(null)
        }}
      />
    </section>
  )
}

const MAX_BYTES = 10 * 1024 * 1024

const uploadSchema = z.object({
  kind: z.enum(CLIENT_FILE_KINDS, "Elige qué documento es"),
  adminOnly: z.boolean(),
  file: z
    .custom<File | null>((value) => value instanceof File, "Elige el archivo")
    .refine(
      (value) => !(value instanceof File) || value.size <= MAX_BYTES,
      "El archivo no puede superar 10 MB",
    ),
})

/**
 * Subir un documento al cliente. Desde Alta llega con el tipo ya elegido
 * («Subir la carta», «Subir lo que mandó»). Soporte solo sube lo que el equipo
 * entero puede ver; el servidor revisa el tipo real del archivo.
 */
export function ClientFileUploadDrawer({
  clientId,
  isAdmin,
  kind = "otro",
  onClose,
}: {
  clientId: string
  isAdmin: boolean
  kind?: ClientFileKind
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const kinds = CLIENT_FILE_KINDS.filter(
    (item) => item !== "correo" && (isAdmin || !ADMIN_KINDS.has(item)),
  )
  const save = useMutation({
    mutationFn: (body: FormData) =>
      api(`/api/admin/clients/${clientId}/files`, { method: "POST", body }),
  })
  const form = useAppForm({
    defaultValues: {
      kind: (kinds.includes(kind) ? kind : "otro") as ClientFileKind,
      adminOnly: isAdmin,
      file: null as File | null,
    },
    validators: { onSubmit: uploadSchema },
    onSubmit: async ({ value }) => {
      if (!value.file) throw new Error("Elige el archivo")
      const body = new FormData()
      body.append("file", value.file, value.file.name)
      body.append("kind", value.kind)
      body.append("adminOnly", String(isAdmin && (value.adminOnly || CLINIC_SENT.has(value.kind))))
      await save.mutateAsync(body)
      toast.success(`Se guardó ${value.file.name}`)
      invalidateClient(queryClient, clientId)
      onClose()
    },
  })
  const surface = useFormSurface(form)
  const chosen = useStore(form.store, (state) => state.values.kind)
  return (
    <FormDrawer {...surface} open title="Subir un documento" submitLabel="Subir" onClose={onClose}>
      <form.AppField name="kind">
        {(field) => (
          <field.SelectField
            id="client-file-kind"
            label="Qué es"
            options={kinds.map((item) => ({ value: item, label: FILE_KIND_WORDS[item] }))}
          />
        )}
      </form.AppField>
      <form.AppField name="file">
        {(field) => (
          <field.Control id="client-file" label={`Archivo (${CLIENT_FILE_TYPES_HINT})`}>
            {(control) => (
              <Input
                {...control.props}
                type="file"
                accept={CLIENT_FILE_ACCEPT}
                onChange={(event) => {
                  field.handleChange(event.target.files?.[0] ?? null)
                  field.handleBlur()
                }}
              />
            )}
          </field.Control>
        )}
      </form.AppField>
      {isAdmin ? (
        CLINIC_SENT.has(chosen) ? (
          <p className="text-sm text-muted-foreground">
            Lo de la carga de datos queda solo para Administración y se borra a los 30 días, como
            dice el contrato de encargo.
          </p>
        ) : (
          <form.AppField name="adminOnly">
            {(field) => (
              <field.CheckboxField
                id="client-file-admin-only"
                label="Solo Administración"
                description="Soporte no lo ve. Sin marcar, lo ve todo el equipo."
              />
            )}
          </form.AppField>
        )
      ) : (
        <p className="text-sm text-muted-foreground">Lo ve todo el equipo de la administración.</p>
      )}
    </FormDrawer>
  )
}
