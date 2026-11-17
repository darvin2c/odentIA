/**
 * Los cajones del historial de la ficha (ADR 0196): toda fila abre algo. Lo que no tiene su propio
 * cajón en otra parte se lee aquí, de solo lectura: lo anotado (su texto entero), un envío que no
 * es de una conversación (a quién, qué decía y cómo quedó, con «Salió / No salió» si falta
 * decirlo), una tarea hecha, un informe de la carga (quién, cuándo, a quién y su PDF) y una carga
 * (sus cifras y el informe que salió después). Nada de esto envía ni cambia lo que pasó.
 */
import { Badge, Button, toast } from "@odentia/ui"
import { DetailDrawer, DetailField, DetailList, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation } from "@tanstack/react-query"
import { useState } from "react"
import { z } from "zod"
import { api } from "../../lib/api"
import { supportDayTime } from "../../lib/support-words"
import { LOAD_WORDS, reportLine, useOrgLoadRecord } from "../org-load-record"
import { clientReportContentPath } from "./client-file-model"
import { HISTORY_CATEGORY_WORDS, type TimelineEntry, TASK_KIND_WORDS, wordOf } from "./client-model"
import { PdfPages } from "./file-viewer"
import { resolveOutreach, useClientTasks, useInvalidateClient } from "./sale-api"
import { dayWords } from "./sale-words"

const CHANNEL_WORDS: Record<string, string> = {
  correo: "Correo",
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
}

/** Cómo quedó un envío, sin decir más de lo que se sabe: salió no es que lo leyó. */
const ENVIO_STATUS_WORDS: Record<string, string> = {
  pendiente: "Falta decir si salió",
  incierto: "No se sabe si salió",
  no_salio: "No salió",
  enviado: "Salió",
}

/** Quién y cuándo, como en la fila. */
function WhoWhen({ entry }: { entry: TimelineEntry }) {
  return (
    <>
      <DetailField label="Cuándo">{supportDayTime(entry.at)}</DetailField>
      <DetailField label="Quién">{entry.who.name}</DetailField>
      <DetailField label="De">{wordOf(HISTORY_CATEGORY_WORDS, entry.category, "Otro")}</DetailField>
    </>
  )
}

/**
 * Una fila sin cajón propio (lo anotado, o lo que quien mira no puede abrir): lo que dice entera,
 * con su texto y en qué quedó.
 */
export function HistoryEntryDrawer({
  entry,
  onClose,
}: {
  entry: TimelineEntry | null
  onClose: () => void
}) {
  if (!entry) return null
  const text = entry.body ?? entry.detail
  return (
    <DetailDrawer open onClose={onClose} title={entry.title}>
      <DetailList>
        <WhoWhen entry={entry} />
        {text ? (
          <DetailField label="Qué pasó">
            <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</span>
          </DetailField>
        ) : null}
        {entry.outcome ? (
          <DetailField label="En qué quedó">
            <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{entry.outcome}</span>
          </DetailField>
        ) : null}
      </DetailList>
    </DetailDrawer>
  )
}

/**
 * Un envío que no es de una conversación (un «Escribir» que salió, uno por confirmar o incierto):
 * por dónde, a quién, qué decía y cómo quedó. Lo que falta decir se resuelve con «Salió / No
 * salió», la misma operación de «Escribir»; nunca se reenvía desde aquí.
 */
export function EnvioDrawer({
  clientId,
  entry,
  onClose,
}: {
  clientId: string
  entry: TimelineEntry | null
  onClose: () => void
}) {
  const invalidate = useInvalidateClient(clientId)
  const resolve = useMutation({
    mutationFn: (input: { id: string; outcome: "salio" | "no_salio" }) =>
      resolveOutreach(input.id, input.outcome),
    onSuccess: (_, input) => {
      toast.success(
        input.outcome === "salio" ? "Anotado: salió. Queda en su historial." : "Anotado: no salió.",
      )
      invalidate()
      onClose()
    },
  })
  const link = entry?.link
  if (!entry || !link) return null
  const envio = entry.envio
  const open = envio?.status === "pendiente" || envio?.status === "incierto"
  const id = link.id
  return (
    <DetailDrawer
      open
      onClose={onClose}
      title={entry.title}
      error={resolve.isError ? submitErrorMessage(resolve.error) : null}
      isSubmitting={resolve.isPending}
      actions={
        open ? (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={resolve.isPending}
              onClick={() => resolve.mutate({ id, outcome: "no_salio" })}
            >
              No salió
            </Button>
            <Button
              type="button"
              disabled={resolve.isPending}
              onClick={() => resolve.mutate({ id, outcome: "salio" })}
            >
              Salió
            </Button>
          </>
        ) : undefined
      }
    >
      <DetailList>
        <WhoWhen entry={entry} />
        {envio ? (
          <>
            <DetailField label="Por">{wordOf(CHANNEL_WORDS, envio.channel, "Correo")}</DetailField>
            <DetailField label="Para">
              <span className="[overflow-wrap:anywhere]">{envio.to}</span>
            </DetailField>
            {envio.subject ? <DetailField label="Asunto">{envio.subject}</DetailField> : null}
            <DetailField label="Mensaje">
              <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{envio.body}</span>
            </DetailField>
            <DetailField label="Cómo quedó">
              {wordOf(ENVIO_STATUS_WORDS, envio.status, envio.status)}
            </DetailField>
          </>
        ) : entry.detail ? (
          <DetailField label="Mensaje">
            <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{entry.detail}</span>
          </DetailField>
        ) : null}
      </DetailList>
      {open ? (
        <p className="text-sm text-muted-foreground">
          Si no sabes, revisa donde salió (Zoho o el WhatsApp de Sallca) antes de decirlo: desde
          aquí no se vuelve a enviar.
        </p>
      ) : null}
    </DetailDrawer>
  )
}

/** Una tarea hecha: qué era, para cuándo estaba, quién la cerró y lo que se anotó al cerrarla. */
export function TaskDoneDrawer({
  clientId,
  taskId,
  entry,
  onClose,
}: {
  clientId: string
  taskId: string | null
  entry: TimelineEntry | null
  onClose: () => void
}) {
  const tasks = useClientTasks(clientId, "hecha", taskId !== null)
  if (!taskId || !entry) return null
  const task = tasks.data?.find((row) => row.id === taskId) ?? null
  return (
    <DetailDrawer
      open
      onClose={onClose}
      title={entry.title}
      isLoading={tasks.isPending}
      error={tasks.isError ? submitErrorMessage(tasks.error) : null}
    >
      <DetailList>
        <WhoWhen entry={entry} />
        {task ? (
          <>
            <DetailField label="Qué era">{wordOf(TASK_KIND_WORDS, task.kind, "Tarea")}</DetailField>
            <DetailField label="Para el">{dayWords(task.dueOn)}</DetailField>
            {task.byKairos ? <DetailField label="La puso">Kairós</DetailField> : null}
          </>
        ) : null}
        {(task?.doneNote ?? entry.detail) ? (
          <DetailField label="Al cerrarla">
            <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">
              {task?.doneNote ?? entry.detail}
            </span>
          </DetailField>
        ) : null}
      </DetailList>
    </DetailDrawer>
  )
}

/**
 * Un informe de la carga: su número, cómo salió (sin decir que lo leyó) y su PDF tal como salió,
 * dibujado en el cajón. Solo Administración, como el registro de la carga.
 */
export function InformeDrawer({
  clientId,
  organizationId,
  number,
  onClose,
}: {
  clientId: string
  organizationId: string
  number: number | null
  onClose: () => void
}) {
  const record = useOrgLoadRecord(number !== null ? organizationId : null)
  const [opening, setOpening] = useState<string | null>(null)
  if (number === null) return null
  const report = record.data?.reports.find((item) => item.number === number) ?? null
  // Para llevárselo: la dirección firmada del registro, de 5 minutos, se pide al tocar.
  const download = async () => {
    setOpening(null)
    try {
      const { url } = z
        .object({ url: z.string() })
        .parse(await api<unknown>(`/api/admin/imports/${organizationId}/reports/${number}/pdf`))
      window.open(url, "_blank", "noopener,noreferrer")
    } catch (failure) {
      setOpening(submitErrorMessage(failure))
    }
  }
  return (
    <DetailDrawer
      open
      onClose={onClose}
      dock={false}
      size="xl"
      className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(56rem,calc(100vw-2rem))]"
      title={`Informe N.º ${number}`}
      description={report?.stage ?? undefined}
      isLoading={record.isPending}
      error={
        record.isError
          ? submitErrorMessage(record.error)
          : record.isSuccess && !report
            ? "Ese informe ya no está en el registro de la carga."
            : opening
      }
      actions={
        report?.hasPdf ? (
          <Button type="button" variant="outline" onClick={() => void download()}>
            Descargar el PDF
          </Button>
        ) : undefined
      }
    >
      {report ? (
        <div className="flex flex-col gap-4">
          <DetailList>
            <DetailField label="Cómo salió">{reportLine(report)}</DetailField>
            {report.to ? <DetailField label="A quién">{report.to}</DetailField> : null}
            {report.by ? <DetailField label="Quién">{report.by}</DetailField> : null}
          </DetailList>
          {report.hasPdf ? (
            <PdfPages
              path={clientReportContentPath(clientId, number)}
              title={`Informe N.º ${number}`}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              Este informe salió antes de guardar su PDF: no hay copia que ver.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            «Salió» es que el correo lo aceptó; si rebota, el aviso llega al buzón de soporte. No se
            sabe si lo abrió.
          </p>
        </div>
      ) : null}
    </DetailDrawer>
  )
}

/**
 * Una carga de la skill: qué se cargó, cuándo, quién y con qué cifras, y el informe que salió
 * después de ella (el primero desde ese momento), que se abre en su cajón.
 */
export function CargaDrawer({
  organizationId,
  loadId,
  onClose,
  onOpenReport,
}: {
  organizationId: string
  loadId: string | null
  onClose: () => void
  onOpenReport: (number: number) => void
}) {
  const record = useOrgLoadRecord(loadId !== null ? organizationId : null)
  if (loadId === null) return null
  const load = record.data?.loads.find((item) => item.id === loadId) ?? null
  const after = load
    ? ([...(record.data?.reports ?? [])]
        .filter((item) => Date.parse(item.at) >= Date.parse(load.at))
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0] ?? null)
    : null
  return (
    <DetailDrawer
      open
      onClose={onClose}
      title={load ? `Carga de ${LOAD_WORDS[load.kind].toLowerCase()}` : "Carga"}
      isLoading={record.isPending}
      error={
        record.isError
          ? submitErrorMessage(record.error)
          : record.isSuccess && !load
            ? "Esa carga ya no está en el registro."
            : null
      }
    >
      {load ? (
        <div className="flex flex-col gap-4">
          <DetailList>
            <DetailField label="Cuándo">{supportDayTime(load.at)}</DetailField>
            <DetailField label="Quién">{load.by ?? "La skill de carga"}</DetailField>
            <DetailField label="Lo que quedó">{load.summary}</DetailField>
            {load.errors ? (
              <DetailField label="No entraron">
                <Badge variant="outline">{load.errors}</Badge>
              </DetailField>
            ) : null}
          </DetailList>
          <section aria-labelledby="carga-informe" className="flex flex-col gap-1">
            <h3 id="carga-informe" className="text-sm font-semibold">
              El informe que salió después
            </h3>
            {after ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm">
                  N.º {after.number}
                  {after.stage ? ` · ${after.stage}` : ""} · {reportLine(after)}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onOpenReport(after.number)}
                >
                  Ver el informe
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Todavía no salió un informe después de esta carga.
              </p>
            )}
          </section>
          <p className="text-xs text-muted-foreground">
            La carga la hace la skill en el servidor: aquí solo se lee lo que hizo.
          </p>
        </div>
      ) : null}
    </DetailDrawer>
  )
}
