import { activeFindingsAsOf, ODONTOGRAM_STANDARD } from "@odentia/clinical"
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { type PointerEvent, useEffect, useId, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { apiFetch } from "../lib/api"
import type { OdontogramAssessment, OdontogramEntry, PatientFull } from "../lib/patients"
import { OdontogramDocument } from "./odontogram-document"

const PURPOSES: Record<OdontogramAssessment["purpose"], string> = {
  initial: "Inicio del plan de tratamiento",
  new_findings: "Nuevos hallazgos clínicos",
  completion: "Culminación del plan de tratamiento",
  reentry: "Reingreso del paciente",
  legal: "Solicitud judicial",
  personal: "Solicitud personal",
}

interface PrintableSnapshot {
  entries: OdontogramEntry[]
  date?: string
  specifications?: string
  observations?: string
  examinerName?: string
  registrationNumber?: string
  signature?: number[][][]
  patientName?: string
  draft: boolean
}

export function OdontogramAssessments({
  patientId,
  history,
  readOnly,
  disabled,
  beforeWrite,
  onPendingChange,
}: {
  patientId: string
  history: OdontogramEntry[]
  readOnly: boolean
  disabled: boolean
  beforeWrite?: () => Promise<void>
  onPendingChange?: (pending: boolean) => void
}) {
  const id = useId()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState("current")
  const [purpose, setPurpose] = useState<OdontogramAssessment["purpose"]>("initial")
  const [specifications, setSpecifications] = useState("")
  const [observations, setObservations] = useState("")
  const [examinerName, setExaminerName] = useState("")
  const [registrationNumber, setRegistrationNumber] = useState("")
  const [signature, setSignature] = useState<number[][][]>([])
  const [confirmed, setConfirmed] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [printDocument, setPrintDocument] = useState<PrintableSnapshot | null>(null)
  const previewTitleRef = useRef<HTMLHeadingElement>(null)
  const query = useQuery({
    queryKey: ["odontogram-assessments", patientId],
    queryFn: () =>
      apiFetch<{ data: OdontogramAssessment[] }>(
        `/api/patients/${patientId}/odontogram/assessments`,
      ),
  })
  const assessments = query.data?.data ?? []
  const assessment = assessments.find((item) => item.id === selected)
  const reviewCount = history.filter(
    (entry) => entry.needsReview && entry.status !== "voided",
  ).length
  const dirty = !!(
    specifications ||
    observations ||
    examinerName ||
    registrationNumber ||
    signature.length ||
    confirmed
  )
  const patientQuery = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`),
  })
  const documentEntries = assessment?.entries ?? activeFindingsAsOf(history)
  const draftName = patientQuery.data?.data.displayName ?? undefined
  const preview: PrintableSnapshot = assessment
    ? {
        entries: assessment.entries,
        date: assessment.createdAt,
        specifications: assessment.specifications,
        observations: assessment.observations,
        examinerName: assessment.examinerName,
        registrationNumber: assessment.registrationNumber,
        signature: assessment.signature,
        patientName: `${assessment.patientName} · HC-${String(assessment.patientNumber).padStart(6, "0")}`,
        draft: false,
      }
    : {
        entries: documentEntries,
        specifications: "",
        observations: "",
        patientName: draftName,
        draft: true,
      }
  const previewLabel = assessment
    ? `${new Date(assessment.createdAt).toLocaleString("es-PE")} · ${PURPOSES[assessment.purpose]} · ${assessment.examinerName}`
    : "Borrador actual · sin firmar"

  useEffect(() => {
    if (!printDocument) return
    const finish = () => {
      document.body.classList.remove("odontogram-printing")
      setPrintDocument(null)
    }
    document.body.classList.add("odontogram-printing")
    window.addEventListener("afterprint", finish, { once: true })
    const frame = window.requestAnimationFrame(() => window.print())
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener("afterprint", finish)
      document.body.classList.remove("odontogram-printing")
    }
  }, [printDocument])

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (pending || disabled || readOnly) return
    if (
      !examinerName.trim() ||
      !registrationNumber.trim() ||
      !signature.some((stroke) => stroke.length >= 2) ||
      !confirmed
    ) {
      setError("Completa la identificación profesional, firma y confirmación de la evaluación.")
      return
    }
    setPending(true)
    onPendingChange?.(true)
    setError(null)
    try {
      await beforeWrite?.()
      const result = await apiFetch<{ data: OdontogramAssessment }>(
        `/api/patients/${patientId}/odontogram/assessments`,
        {
          method: "POST",
          body: JSON.stringify({
            purpose,
            specifications: specifications.trim(),
            observations: observations.trim(),
            examinerName: examinerName.trim(),
            registrationNumber: registrationNumber.trim(),
            signature,
          }),
        },
      )
      await queryClient.invalidateQueries({ queryKey: ["odontogram-assessments", patientId] })
      setSelected(result.data.id)
      setOpen(false)
      setSpecifications("")
      setObservations("")
      setSignature([])
      setConfirmed(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo registrar la evaluación.")
    } finally {
      setPending(false)
      onPendingChange?.(false)
    }
  }

  return (
    <section
      className="min-w-0 rounded-lg border p-4 sm:p-6"
      aria-label="Documento normativo del odontograma"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="text-lg font-semibold">Evaluaciones del odontograma</h3>
          <p className="text-sm text-muted-foreground">
            {ODONTOGRAM_STANDARD} (RM 559-2022-MINSA). El gráfico operativo es una vista de trabajo;
            solo la evaluación firmada conserva el documento inalterable con sus hallazgos
            (numerales 5.6, 5.8 y 5.10).
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          {!readOnly && (
            <Button
              disabled={disabled || pending || query.isPending}
              onClick={() => {
                setError(null)
                setOpen(true)
              }}
            >
              Registrar evaluación
            </Button>
          )}
          <Button variant="outline" onClick={() => setPreviewOpen(true)}>
            Ver documento normativo
          </Button>
        </div>
      </div>
      {query.isError && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {query.error.message}{" "}
          <Button variant="link" onClick={() => query.refetch()}>
            Reintentar
          </Button>
        </p>
      )}
      <div className="my-4 flex flex-wrap items-end gap-3">
        <Field className="w-full sm:max-w-md">
          <FieldLabel htmlFor={`${id}-assessment`}>Documento</FieldLabel>
          <Select
            value={selected}
            onValueChange={(value) => setSelected(value ?? "current")}
            items={{
              current: "Borrador actual · sin firmar",
              ...Object.fromEntries(
                assessments.map((item) => [
                  item.id,
                  `${new Date(item.createdAt).toLocaleString("es-PE")} · ${PURPOSES[item.purpose]} · ${item.examinerName}`,
                ]),
              ),
            }}
          >
            <SelectTrigger id={`${id}-assessment`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="current">Borrador actual · sin firmar</SelectItem>
              {assessments.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {new Date(item.createdAt).toLocaleString("es-PE")} · {PURPOSES[item.purpose]} ·{" "}
                  {item.examinerName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {assessment ? (
          <Badge variant="outline">Evaluación firmada · solo lectura</Badge>
        ) : (
          <Badge variant="outline">Vista de trabajo · no es evaluación firmada</Badge>
        )}
      </div>
      {assessment && (
        <p className="mb-4 text-sm text-muted-foreground">
          {previewLabel} · COP {assessment.registrationNumber} · {assessment.entries.length}{" "}
          hallazgos conservados.
        </p>
      )}
      <FormDrawer
        open={open}
        onClose={() => setOpen(false)}
        title="Registrar evaluación del odontograma"
        description="Confirma la evaluación clínica completa. Se conservarán los hallazgos observados actuales, la fecha y tu firma; las correcciones posteriores no alterarán este documento."
        onSubmit={save}
        isDirty={dirty}
        isSubmitting={pending}
        error={error}
        submitLabel="Firmar y conservar evaluación"
        submitDisabled={disabled || readOnly || reviewCount > 0 || !confirmed}
        className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(48rem,calc(100vw-2rem))]"
      >
        <div className="flex flex-col gap-4">
          {reviewCount > 0 && (
            <p role="alert" className="rounded-lg border p-3 text-sm">
              Revisa los {reviewCount} registros anteriores antes de firmar. Registra el hallazgo
              completo y corrige el registro previo con motivo; no se pueden asumir sus datos
              faltantes.
            </p>
          )}
          <Field>
            <FieldLabel htmlFor={`${id}-purpose`}>Momento de evaluación</FieldLabel>
            <Select
              value={purpose}
              items={PURPOSES}
              onValueChange={(value) => {
                if (value && value in PURPOSES) setPurpose(value as OdontogramAssessment["purpose"])
              }}
              disabled={pending}
            >
              <SelectTrigger id={`${id}-purpose`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(PURPOSES).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-specifications`}>Especificaciones</FieldLabel>
            <Textarea
              id={`${id}-specifications`}
              value={specifications}
              onChange={(event) => setSpecifications(event.target.value)}
              maxLength={4000}
              disabled={pending}
              placeholder="Detalles adicionales de los hallazgos y clasificaciones utilizadas."
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-observations`}>Observaciones</FieldLabel>
            <Textarea
              id={`${id}-observations`}
              value={observations}
              onChange={(event) => setObservations(event.target.value)}
              maxLength={4000}
              disabled={pending}
              placeholder="Hallazgos no contemplados en la nomenclatura."
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`${id}-examiner`}>Cirujano dentista</FieldLabel>
              <Input
                id={`${id}-examiner`}
                value={examinerName}
                onChange={(event) => setExaminerName(event.target.value)}
                maxLength={200}
                required
                disabled={pending}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-registration`}>Número de colegiatura (COP)</FieldLabel>
              <Input
                id={`${id}-registration`}
                value={registrationNumber}
                onChange={(event) => setRegistrationNumber(event.target.value)}
                maxLength={40}
                required
                disabled={pending}
              />
            </Field>
          </div>
          <SignatureInput value={signature} onChange={setSignature} disabled={pending} />
          <p className="text-xs text-muted-foreground">
            Firma manuscrita capturada y vinculada al usuario autenticado. No equivale a una firma
            digital certificada. La evaluación y la identidad profesional declarada son
            responsabilidad del cirujano dentista.
          </p>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={confirmed}
              onCheckedChange={(value) => setConfirmed(value === true)}
              disabled={pending}
            />
            Confirmo que he evaluado al paciente y que estos son los hallazgos clínicos observados,
            no procedimientos propuestos.
          </label>
        </div>
      </FormDrawer>
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent
          initialFocus={previewTitleRef}
          className="max-h-[90vh] w-full overflow-y-auto sm:max-w-4xl"
        >
          <DialogHeader>
            <DialogTitle ref={previewTitleRef} tabIndex={-1}>
              Documento normativo del odontograma
            </DialogTitle>
            <DialogDescription>
              {preview.draft
                ? "Borrador actual sin firmar: lectura del estado de trabajo. Solo la evaluación firmada es el documento conservado e inalterable."
                : `Evaluación firmada · ${previewLabel}. Copia inalterable de sus hallazgos.`}
            </DialogDescription>
          </DialogHeader>
          <div className="min-w-0 rounded-lg bg-white p-3 text-black">
            {preview.draft && (
              <p className="mb-2 rounded border border-dashed p-2 text-center text-xs font-semibold uppercase tracking-wide">
                Borrador · sin firma · no es documento firmado
              </p>
            )}
            <OdontogramDocument
              entries={preview.entries}
              date={preview.date}
              specifications={preview.specifications}
              observations={preview.observations}
              examinerName={preview.examinerName}
              registrationNumber={preview.registrationNumber}
              signature={preview.signature}
              patientName={preview.patientName}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewOpen(false)}>
              Cerrar
            </Button>
            <Button
              onClick={() => {
                setPreviewOpen(false)
                setPrintDocument(preview)
              }}
            >
              {preview.draft ? "Imprimir borrador (sin firmar)" : "Imprimir / guardar PDF"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {printDocument &&
        typeof document !== "undefined" &&
        createPortal(
          <div className="odontogram-print-target">
            <style>{`@media screen {.odontogram-print-target{display:none}} @page {size:A4; margin:11mm} @media print {body.odontogram-printing > :not(.odontogram-print-target){display:none!important} .odontogram-print-target{display:block!important;color:#000;background:#fff} .odontogram-print-target .odontogram-document{max-width:none;overflow:visible}}`}</style>
            {printDocument.draft && (
              <p style={{ textAlign: "center", fontSize: 12, fontWeight: 700 }}>
                BORRADOR · SIN FIRMA · NO ES DOCUMENTO FIRMADO
              </p>
            )}
            <OdontogramDocument
              entries={printDocument.entries}
              date={printDocument.date}
              specifications={printDocument.specifications}
              observations={printDocument.observations}
              examinerName={printDocument.examinerName}
              registrationNumber={printDocument.registrationNumber}
              signature={printDocument.signature}
              patientName={printDocument.patientName}
            />
          </div>,
          document.body,
        )}
    </section>
  )
}

function SignatureInput({
  value,
  onChange,
  disabled,
}: {
  value: number[][][]
  onChange: (strokes: number[][][]) => void
  disabled: boolean
}) {
  const current = useRef<number[][] | null>(null)
  function point(event: PointerEvent<SVGSVGElement>): number[] {
    const bounds = event.currentTarget.getBoundingClientRect()
    return [
      Math.max(0, Math.min(100, ((event.clientX - bounds.left) / bounds.width) * 100)),
      Math.max(0, Math.min(100, ((event.clientY - bounds.top) / bounds.height) * 100)),
    ]
  }
  return (
    <Field>
      <FieldLabel>Firma manuscrita</FieldLabel>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="h-36 w-full touch-none rounded-lg border bg-white"
        role="img"
        aria-label="Área para dibujar la firma manuscrita"
        onPointerDown={(event) => {
          if (disabled || event.button !== 0) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          current.current = [point(event)]
        }}
        onPointerMove={(event) => {
          if (!current.current || disabled) return
          if (current.current.length >= 500) return
          current.current.push(point(event))
          const draft = event.currentTarget.querySelector("[data-signature-draft]")
          draft?.setAttribute("points", current.current.map((p) => p.join(",")).join(" "))
        }}
        onPointerUp={(event) => {
          const stroke = current.current
          current.current = null
          event.currentTarget.querySelector("[data-signature-draft]")?.setAttribute("points", "")
          if (stroke && stroke.length >= 2 && value.length < 50) onChange([...value, stroke])
        }}
        onPointerCancel={(event) => {
          current.current = null
          event.currentTarget.querySelector("[data-signature-draft]")?.setAttribute("points", "")
        }}
      >
        {value.map((stroke, index) => (
          <polyline
            key={index}
            points={stroke.map((p) => p.join(",")).join(" ")}
            fill="none"
            stroke="black"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <polyline
          data-signature-draft=""
          fill="none"
          stroke="black"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || value.length === 0}
        onClick={() => onChange([])}
      >
        Borrar firma
      </Button>
    </Field>
  )
}
