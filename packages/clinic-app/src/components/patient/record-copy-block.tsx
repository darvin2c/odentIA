import { Skeleton } from "@odentia/ui"
import { SubmitButton } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useId, useState } from "react"
import {
  fetchRecordSummary,
  type PatientRecordSummary,
  recordSummaryKey,
  sizeWords,
  startPatientRecordDownload,
} from "../../lib/data-requests"

/** «2 recetas», «1 orden»: una cifra con su nombre; nada si es 0. */
function count(value: number | undefined, one: string, many: string): string | null {
  return value && value > 0 ? `${value} ${value === 1 ? one : many}` : null
}

/** «a, b y c». */
function listed(parts: Array<string | null>): string | null {
  const items = parts.filter((part): part is string => part !== null)
  if (items.length === 0) return null
  const last = items.pop()
  return items.length === 0 ? (last ?? null) : `${items.join(", ")} y ${last}`
}

/** Los papeles emitidos de esta persona, con sus cifras; null si no tiene ninguno. */
export function papersWords(s: PatientRecordSummary): string | null {
  const total =
    s.signedOdontograms +
    s.prescriptions +
    s.orders +
    s.medicalLeaves +
    s.consentsSigned +
    (s.productPapers ?? 0)
  const list = listed([
    count(s.signedOdontograms, "odontograma firmado", "odontogramas firmados"),
    count(s.prescriptions, "receta", "recetas"),
    count(s.orders, "orden", "órdenes"),
    count(s.medicalLeaves, "descanso médico", "descansos médicos"),
    count(s.consentsSigned, "consentimiento firmado", "consentimientos firmados"),
    count(s.productPapers, "papel más", "papeles más"),
  ])
  return list ? `${list}, ${total > 1 ? "cada uno en su PDF" : "en su PDF"}` : null
}

/** Lo que arma la clínica sin que sea un papel entregado: la hoja de cada atención y el odontograma de hoy. */
export function clinicSheetsWords(s: PatientRecordSummary): string | null {
  return listed([
    count(s.attentionSheets, "hoja de atención", "hojas de atención"),
    s.odontogramToday ? "el odontograma de hoy, sin firmar" : null,
  ])
}

/** Sus imágenes y archivos, con sus cifras; null si no tiene ninguno. */
export function filesWords(s: PatientRecordSummary): string | null {
  const images = count(s.images, "imagen", "imágenes")
  const scans =
    s.tomographies > 0
      ? s.tomographies === 1
        ? "su tomografía"
        : `sus ${s.tomographies} tomografías`
      : null
  const others = count(s.otherFiles, "archivo más", "archivos más")
  return listed([images, scans, others])
}

/** Lo que trae, en una frase con las cifras de esta persona; lo que es 0 no se nombra. */
export function contentsWords(s: PatientRecordSummary | undefined): string {
  const parts = s
    ? [papersWords(s), clinicSheetsWords(s), filesWords(s)].filter(
        (part): part is string => part !== null,
      )
    : []
  return `Su historia en PDF para leer${parts.map((part) => `; ${part}`).join("")}; y el archivo para el sistema de otra clínica. Lo anulado va marcado, con su motivo.`
}

/** «CIE-10», «CIE-10 y CIE-11»: las listas de diagnósticos que de verdad usa su copia. */
function diagnosisStandard(
  s: PatientRecordSummary | undefined,
): { name: string; detail: string } | null {
  const systems = s?.diagnosisSystems ?? []
  const name = listed(systems)
  return name ? { name, detail: "sus diagnósticos" } : null
}

/**
 * «Descargar copia»: el navegador la baja por su cuenta, sin cargarla entera en la página
 * (con tomografías pesa cientos de MB). La página no sabe cuándo termina: lo dice en
 * palabras y devuelve el botón al rato, sin aceptar un segundo clic mientras arranca.
 */
export function DownloadCopyButton({
  patientId,
  size,
  variant = "outline",
}: {
  patientId: string
  size?: "sm" | "default"
  variant?: "default" | "outline"
}) {
  const queryClient = useQueryClient()
  const [started, setStarted] = useState(false)
  useEffect(() => {
    if (!started) return
    const timer = setTimeout(() => {
      setStarted(false)
      // La descarga queda en «Consultas a la historia clínica».
      void queryClient.invalidateQueries({ queryKey: ["clinical-access-log", patientId] })
    }, 6000)
    return () => clearTimeout(timer)
  }, [started, patientId, queryClient])
  return (
    <div className="flex flex-col items-start gap-1">
      <SubmitButton
        variant={variant}
        size={size}
        pending={started}
        onClick={() => {
          startPatientRecordDownload(patientId)
          setStarted(true)
        }}
      >
        {started ? "Preparando la copia…" : "Descargar copia"}
      </SubmitButton>
      {started ? (
        <p role="status" className="max-w-64 text-xs text-muted-foreground">
          Tu navegador la está bajando: con tomografías puede tardar unos minutos. Mírala en tus
          descargas.
        </p>
      ) : null}
    </div>
  )
}

/**
 * «Copia de su historia» (mesa del 18 nov), arriba de Datos › Privacidad y pedidos y desde
 * «…» de la cabecera: qué trae con las cifras de esta persona (las de la misma lista que
 * arma el ZIP; lo que es 0 no se nombra), «Descargar copia» y los estándares que de verdad
 * sigue su copia, a la vista y en corto, para que los pedidos queden cerca también en el
 * teléfono. `bare`: dentro de un panel que ya lleva el título, sin tarjeta ni título propio,
 * y «Descargar copia» como la acción principal. Solo para quien lee la historia
 * (`clinical.read`): el servidor lo exige también.
 */
export function RecordCopyBlock({
  patientId,
  bare = false,
}: {
  patientId: string
  bare?: boolean
}) {
  const summary = useQuery({
    queryKey: recordSummaryKey(patientId),
    queryFn: () => fetchRecordSummary(patientId),
    retry: false,
  })
  const titleId = useId()
  const s = summary.data
  const size = s ? sizeWords(s.approxBytes) : null
  const scans = (s?.tomographies ?? 0) > 0
  const diagnoses = diagnosisStandard(s)
  const standards = [
    { name: "HL7 FHIR R4", detail: "para otro sistema" },
    ...(diagnoses ? [diagnoses] : []),
    ...(s?.toothNumbers ? [{ name: "FDI (ISO 3950)", detail: "la numeración de las piezas" }] : []),
    ...(scans ? [{ name: "DICOM", detail: "sus tomografías" }] : []),
  ]
  return (
    <section
      {...(bare ? { "aria-label": "Copia de su historia" } : { "aria-labelledby": titleId })}
      className={
        bare
          ? "flex flex-col gap-3"
          : "elevated flex flex-col gap-3 rounded-xl border bg-card p-4 sm:p-6"
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
          {bare ? null : (
            <h2 id={titleId} className="font-heading text-base font-medium">
              Copia de su historia
            </h2>
          )}
          <p className="text-sm text-muted-foreground">
            Todo en un ZIP, para entregárselo o para que otra clínica siga con su atención
            {size ? ` · ${size}` : ""}.
          </p>
        </div>
        <DownloadCopyButton patientId={patientId} variant={bare ? "default" : "outline"} />
      </div>
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">Qué trae</h3>
        {summary.isPending ? (
          <div role="status" aria-label="Contando lo que trae…" className="flex flex-col gap-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {contentsWords(s)}
            {summary.isError
              ? " No pudimos contar sus papeles e imágenes; la copia los trae igual."
              : ""}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">Estándares que sigue</h3>
        <ul className="grid gap-x-4 gap-y-0.5 text-sm sm:grid-cols-2">
          {standards.map((standard) => (
            <li key={standard.name}>
              <span className="font-medium">{standard.name}</span>
              <span className="text-muted-foreground"> · {standard.detail}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-sm text-muted-foreground">
        <span className="font-semibold text-foreground">Cómo se carga en otro sistema: </span>
        si lee HL7 FHIR R4, con el archivo «.fhir.json», sin volver a escribir nada
        {scans ? "; las tomografías, en cualquier visor DICOM" : ""}. El «LÉEME» del ZIP lo explica.
      </p>
      <p className="text-xs text-muted-foreground">
        No trae presupuestos ni cobros. Cada descarga queda en «Consultas a la historia clínica».
      </p>
    </section>
  )
}
