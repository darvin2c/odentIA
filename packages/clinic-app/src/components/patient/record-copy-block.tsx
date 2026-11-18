import { Skeleton } from "@odentia/ui"
import { SubmitButton, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useId } from "react"
import {
  downloadPatientRecord,
  fetchRecordSummary,
  type PatientRecordSummary,
  recordSummaryKey,
  sizeWords,
} from "../../lib/data-requests"
import { productUi } from "../../product/product-ui"

/** «2 recetas», «1 orden»: una cifra con su nombre; nada si es 0. */
function count(value: number, one: string, many: string): string | null {
  return value > 0 ? `${value} ${value === 1 ? one : many}` : null
}

/** «a, b y c». */
function listed(parts: Array<string | null>): string | null {
  const items = parts.filter((part): part is string => part !== null)
  if (items.length === 0) return null
  const last = items.pop()
  return items.length === 0 ? (last ?? null) : `${items.join(", ")} y ${last}`
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Los papeles emitidos de esta persona, con sus cifras; null si no tiene ninguno. */
export function papersWords(s: PatientRecordSummary): string | null {
  const list = listed([
    count(s.signedOdontograms, "odontograma firmado", "odontogramas firmados"),
    count(s.prescriptions, "receta", "recetas"),
    count(s.orders, "orden", "órdenes"),
    count(s.medicalLeaves, "descanso médico", "descansos médicos"),
    count(s.consentsSigned, "consentimiento firmado", "consentimientos firmados"),
  ])
  const many =
    s.signedOdontograms + s.prescriptions + s.orders + s.medicalLeaves + s.consentsSigned > 1
  return list
    ? `${capital(list)}, ${many ? "cada uno en su PDF" : "en su PDF"}. Lo anulado va marcado, con su motivo.`
    : null
}

/** Sus imágenes y archivos, con sus cifras; null si no tiene ninguno. */
export function filesWords(s: PatientRecordSummary): string | null {
  const images = count(s.images, "imagen tal como se subió", "imágenes tal como se subieron")
  const scans =
    s.tomographies > 0
      ? s.tomographies === 1
        ? "su tomografía con todos sus cortes"
        : `sus ${s.tomographies} tomografías con todos sus cortes`
      : null
  const others = count(s.otherFiles, "archivo más", "archivos más")
  const list = listed([images, scans, others])
  return list ? `${capital(list)}.` : null
}

/**
 * Una fila término y descripción: en el teléfono, en una sola línea corrida («HL7 FHIR R4 · …»)
 * para que el bloque no empuje los pedidos fuera de la vista; desde `sm`, en dos columnas.
 */
function Row({ term, children }: { term: string; children: string }) {
  return (
    <div className="py-1.5 text-sm sm:flex sm:gap-4 sm:py-2">
      <dt className="inline font-medium sm:block sm:w-48 sm:shrink-0">{term}</dt>
      <dd className="inline min-w-0 text-muted-foreground sm:block">
        <span aria-hidden className="sm:hidden">
          {" · "}
        </span>
        {children}
      </dd>
    </div>
  )
}

/**
 * «Copia de su historia» (mesa del 18 nov), arriba de Datos › Privacidad y pedidos y desde
 * «…» de la cabecera: qué trae con las cifras de esta persona (las de la misma lista que
 * arma el ZIP; lo que es 0 no se nombra), «Descargar copia» y los estándares que sigue, a la
 * vista. Solo para quien lee la historia (`clinical.read`): el servidor lo exige también.
 */
export function RecordCopyBlock({ patientId }: { patientId: string }) {
  const summary = useQuery({
    queryKey: recordSummaryKey(patientId),
    queryFn: () => fetchRecordSummary(patientId),
    retry: false,
  })
  const titleId = useId()
  const queryClient = useQueryClient()
  const download = useMutation({
    mutationFn: () => downloadPatientRecord(patientId),
    // La descarga queda en «Consultas a la historia clínica»: se ve al momento.
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["clinical-access-log", patientId] }),
  })
  const s = summary.data
  const size = s ? sizeWords(s.approxBytes) : null
  const papers = s ? papersWords(s) : null
  const files = s ? filesWords(s) : null
  const scans = (s?.tomographies ?? 0) > 0
  const standards = [
    {
      name: "HL7 FHIR R4",
      detail: "El formato internacional para pasar la historia al sistema de otra clínica.",
    },
    { name: "CIE-10 y CIE-11", detail: "El código de cada diagnóstico." },
    ...(productUi().record.copyStandards ?? []),
    ...(scans ? [{ name: "DICOM", detail: "Sus tomografías, tal como salieron del equipo." }] : []),
  ]
  return (
    <section
      aria-labelledby={titleId}
      className="elevated flex flex-col gap-4 rounded-xl border bg-card p-4 sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
          <h2 id={titleId} className="font-heading text-base font-medium">
            Copia de su historia
          </h2>
          <p className="text-sm text-muted-foreground">
            Todo lo de su historia en un archivo ZIP, para entregárselo o para que otra clínica siga
            con su atención
            {size ? `. Pesa ${size}.` : "."}
          </p>
        </div>
        <SubmitButton
          variant="outline"
          pending={download.isPending}
          onClick={() => download.mutate()}
        >
          {download.isPending ? "Preparando la copia…" : "Descargar copia"}
        </SubmitButton>
      </div>
      {download.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {submitErrorMessage(download.error)}
        </p>
      ) : null}
      <div>
        <h3 className="text-sm font-semibold">Qué trae</h3>
        <dl className="divide-y">
          <Row term="Su historia para leer · PDF">
            Sus datos, alergias y antecedentes, cada atención con su diagnóstico, el plan con lo que
            decidió y lo que sigue.
          </Row>
          {papers ? <Row term="Cada papel emitido">{papers}</Row> : null}
          {files ? <Row term="Sus imágenes y archivos">{files}</Row> : null}
          <Row term="Para el sistema de otra clínica">
            Lo mismo, en el formato internacional, para cargarlo sin volver a escribirlo.
          </Row>
        </dl>
        {summary.isPending ? (
          <div
            role="status"
            aria-label="Contando lo que trae…"
            className="flex flex-col gap-2 py-2"
          >
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : null}
        {summary.isError ? (
          <p className="py-2 text-sm text-muted-foreground">
            No pudimos contar sus papeles e imágenes; la copia los trae igual.
          </p>
        ) : null}
      </div>
      <div>
        <h3 className="text-sm font-semibold">Estándares que sigue</h3>
        <dl className="divide-y">
          {standards.map((standard) => (
            <Row key={standard.name} term={standard.name}>
              {standard.detail}
            </Row>
          ))}
        </dl>
      </div>
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">Cómo se carga en otro sistema</h3>
        <p className="text-sm text-muted-foreground">
          El sistema de la otra clínica importa el archivo «.fhir.json» sin volver a escribir nada
          {scans ? "; las tomografías se abren en cualquier visor DICOM" : ""}. El ZIP trae un
          «LÉEME» que lo explica.
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        No trae presupuestos ni cobros: no son parte de la historia clínica. Cada descarga queda en
        «Consultas a la historia clínica».
      </p>
    </section>
  )
}
