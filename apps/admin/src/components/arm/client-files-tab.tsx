/**
 * Ficha del cliente › Documentos (ARM, ADR 0185 y 0196): lo que llegó de la clínica (por correo,
 * por un chat o subido como lo que mandó) y lo que salió de nosotros (carta, propuestas,
 * presentaciones, otros y, para Administración, los informes de la carga), en miniaturas
 * alineadas: la imagen, la primera página del PDF o su ícono. Cada uno se abre en el visor
 * (`file-viewer.tsx`), nunca como página dentro de la administración; ahí van «Descargar», «Es la
 * carga de datos» y «Borrar». Lo que manda la clínica es solo de Administración; se borra a los 30
 * días de llegar solo lo que Administración dice que es la carga de datos (lo promete el contrato
 * de encargo). Soporte no ve lo que es solo de Administración y la API tampoco se lo da.
 */
import { Button, Input, toast } from "@odentia/ui"
import {
  EmptyState,
  ErrorState,
  FormDrawer,
  SkeletonRegion,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Upload } from "lucide-react"
import { type ReactNode, useState } from "react"
import { z } from "zod"
import { api } from "../../lib/api"
import { supportDay } from "../../lib/support-words"
import { type Report, useOrgLoadRecord } from "../org-load-record"
import { ClientFilesSkeleton } from "../skeletons/client-account"
import type { ClientTabProps } from "./account-tabs"
import {
  CLIENT_FILE_ACCEPT,
  CLIENT_FILE_KINDS,
  CLIENT_FILE_TYPES_HINT,
  type ClientFile,
  type ClientFileKind,
  cameFromClinic,
  clientReportContentPath,
  deleteOnWords,
  FILE_KIND_WORDS,
  fileDay,
  useClientFiles,
  whoWords,
} from "./client-file-model"
import { InformeDrawer } from "./client-history-drawers"
import { invalidateClient } from "./client-model"
import { FileThumb, FileViewer, PdfThumb } from "./file-viewer"

// El modelo de los documentos vive en `client-file-model.tsx`; estos nombres se siguen leyendo de
// aquí (el correo, los chats, Alta y las respuestas con archivos).
export {
  CLIENT_FILE_ACCEPT,
  CLIENT_FILE_KINDS,
  CLIENT_FILE_TYPES_HINT,
  type CargaCandidate,
  type ClientFile,
  type ClientFileKind,
  cargaConfirmWords,
  cargaMarkedWords,
  clientFileHref,
  clientFilesKey,
  deleteOnWords,
  FILE_KIND_WORDS,
  type MarkCargaResult,
  markCargaResultSchema,
  useClientFiles,
  useMarkCarga,
} from "./client-file-model"

/** Lo que solo maneja Administración (lo que trae datos de la clínica); el servidor lo exige. */
const ADMIN_KINDS: ReadonlySet<ClientFileKind> = new Set(["archivo_clinica", "correo"])
/** Lo de la carga que se sube a mano: solo de Administración y se borra a los 30 días. */
const CLINIC_SENT: ReadonlySet<ClientFileKind> = new Set(["archivo_clinica"])

const GRID = "grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4"
const CARD =
  "relative flex min-w-0 flex-col overflow-hidden rounded-lg border bg-card transition-colors hover:bg-muted/40 focus-within:ring-3 focus-within:ring-ring/40"
/** El nombre es el botón de la tarjeta: tocar cualquier parte la abre, y el teclado llega a él. */
const CARD_BUTTON =
  "line-clamp-2 text-left text-sm font-medium outline-none after:absolute after:inset-0 [overflow-wrap:anywhere]"

export function ClientFilesTab({ clientId, organizationId, isAdmin }: ClientTabProps) {
  const [uploading, setUploading] = useState(false)
  const [viewing, setViewing] = useState<string | null>(null)
  const [report, setReport] = useState<number | null>(null)
  const files = useClientFiles(clientId)
  // Los informes de la carga que salieron, con su PDF: solo Administración (el servidor lo exige).
  const record = useOrgLoadRecord(isAdmin ? organizationId : null)

  if (files.isPending)
    return (
      <SkeletonRegion message="Cargando los documentos…">
        <ClientFilesSkeleton />
      </SkeletonRegion>
    )

  const items = files.data?.items ?? []
  const arrived = items.filter(cameFromClinic)
  const sent = items.filter((file) => !cameFromClinic(file))
  const reports = (record.data?.reports ?? []).filter((item) => item.state !== "enviando")
  const open = items.find((file) => file.id === viewing) ?? null

  return (
    <section aria-labelledby="documentos" className="flex flex-col gap-4">
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
          {items.length === 0 && reports.length === 0 ? (
            <EmptyState
              title="Sin documentos"
              description="Aquí quedan la carta de bienvenida, las propuestas, las presentaciones y lo que mande la clínica."
              actionLabel="Subir un documento"
              onAction={() => setUploading(true)}
            />
          ) : (
            <>
              {isAdmin ? (
                <p className="text-xs text-muted-foreground">
                  «lo ve Soporte» marca lo que Soporte también ve; lo demás es solo de
                  Administración.
                </p>
              ) : null}
              <FileGroup
                id="documentos-llegaron"
                title="Llegaron"
                hint="De la clínica: por correo, por un chat o lo que se subió como lo que mandó."
                empty="Aún no llegó nada de la clínica."
                count={arrived.length}
              >
                {arrived.map((file) => (
                  <FileCard key={file.id} file={file} isAdmin={isAdmin} onOpen={setViewing} />
                ))}
              </FileGroup>
              <FileGroup
                id="documentos-salieron"
                title="Salieron"
                hint="De nosotros: la carta, las propuestas, las presentaciones y los informes de la carga."
                empty="Aún no le mandamos nada."
                count={sent.length + reports.length}
              >
                {sent.map((file) => (
                  <FileCard key={file.id} file={file} isAdmin={isAdmin} onOpen={setViewing} />
                ))}
                {reports.map((item) => (
                  <ReportCard
                    key={`informe-${item.number}`}
                    clientId={clientId}
                    report={item}
                    onOpen={setReport}
                  />
                ))}
              </FileGroup>
            </>
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
      <FileViewer
        clientId={clientId}
        file={open}
        open={open !== null}
        onClose={() => setViewing(null)}
        isAdmin={isAdmin}
      />
      {organizationId ? (
        <InformeDrawer
          clientId={clientId}
          organizationId={organizationId}
          number={report}
          onClose={() => setReport(null)}
        />
      ) : null}
    </section>
  )
}

/** Un grupo de documentos con su título, su cuenta y sus tarjetas en filas alineadas. */
function FileGroup({
  id,
  title,
  hint,
  empty,
  count,
  children,
}: {
  id: string
  title: string
  hint: string
  empty: string
  count: number
  children: ReactNode
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h3 id={id} className="text-sm font-semibold">
          {title} · {count}
        </h3>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      {count ? (
        <ul className={GRID}>{children}</ul>
      ) : (
        <p className="text-sm text-muted-foreground">{empty}</p>
      )}
    </section>
  )
}

/** Una tarjeta: la miniatura, el nombre (que la abre) y de dónde vino. */
function FileCard({
  file,
  isAdmin,
  onOpen,
}: {
  file: ClientFile
  isAdmin: boolean
  onOpen: (fileId: string) => void
}) {
  return (
    <li className={CARD}>
      <div className="aspect-[4/3] w-full overflow-hidden border-b bg-muted/30">
        <FileThumb file={file} />
      </div>
      <div className="flex min-w-0 flex-col gap-0.5 p-3">
        <button type="button" className={CARD_BUTTON} onClick={() => onOpen(file.id)}>
          <span className="sr-only">Ver </span>
          {file.filename}
        </button>
        <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {FILE_KIND_WORDS[file.kind]} · {whoWords(file)} el {supportDay(fileDay(file))}
        </span>
        {file.kind === "archivo_clinica" && file.deleteAfter ? (
          <span className="text-xs text-muted-foreground">{deleteOnWords(file.deleteAfter)}</span>
        ) : null}
        {isAdmin && !file.adminOnly ? (
          <span className="text-xs text-muted-foreground">lo ve Soporte</span>
        ) : null}
      </div>
    </li>
  )
}

/** Un informe de la carga que salió: su primera página y a quién, y se abre en su cajón. */
function ReportCard({
  clientId,
  report,
  onOpen,
}: {
  clientId: string
  report: Report
  onOpen: (number: number) => void
}) {
  return (
    <li className={CARD}>
      <div className="aspect-[4/3] w-full overflow-hidden border-b bg-muted/30">
        {report.hasPdf ? (
          <PdfThumb
            path={clientReportContentPath(clientId, report.number)}
            contentType="application/pdf"
          />
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5 p-3">
        <button type="button" className={CARD_BUTTON} onClick={() => onOpen(report.number)}>
          <span className="sr-only">Ver el </span>
          Informe N.º {report.number}
          {report.stage ? ` · ${report.stage}` : ""}
        </button>
        <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {report.state === "desconocido" ? "No se sabe si salió" : "Salió"} el{" "}
          {supportDay(report.at)}
          {report.to ? ` a ${report.to}` : ""}
        </span>
      </div>
    </li>
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
