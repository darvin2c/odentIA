import type { PatientGuide } from "@odentia/clinical"
import {
  Button,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  Skeleton,
  Textarea,
  toast,
} from "@odentia/ui"
import { DatePickerButton, ErrorState, FormDrawer, regionToday } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useMemo, useRef, useState } from "react"
import {
  type BudgetPresentation,
  type BudgetPresentationBody,
  budgetNumberLabel,
  fetchBudgetDetail,
  fetchBudgetPresentation,
  PLAN_QUERY_KEYS,
  sendBudgetApi,
  updateBudgetPresentation,
} from "../../../lib/budgets"
import { usePermission } from "../../../lib/crm"
import { apiFetch } from "../../../lib/api"
import { formatDate } from "../../../lib/clinical-journey"
import { fetchPatientDiagnoses, type PatientDiagnosis } from "../../../lib/encounters"
import type { PlanItem } from "../../../lib/patients"
import { productUi } from "../../../product/product-ui"
import { GuideFields, GuideSummary, hasGuide } from "../../service-guide"
import { DocumentPaperPanel } from "../document-paper-panel"
import { useBudgetSendPreview } from "./budget-send"
import { mutationMessage } from "./budget-parts"

/** Lo que dice el aviso cuando sale: la misma frase de `BudgetSendButton`. */
function sentWords(name: string, channel: "whatsapp" | "email", via: string): string {
  const where = channel === "whatsapp" ? "por WhatsApp" : "por correo"
  const first = name.trim().split(/\s+/)[0] ?? name
  return via === "plantilla"
    ? `Enviado a ${first} ${where}: le llega el aviso y, al tocarlo, el PDF`
    : `Enviado a ${first} ${where}, con el PDF`
}

interface OptionDraft {
  name: string
  pros: string
  cons: string
}

/**
 * Lo que ya sabe la pantalla de por qué se hace: el diagnóstico de cada
 * tratamiento, por su nombre y con su lugar. Solo propone: nada se guarda hasta
 * confirmar. Sin el nombre del diagnóstico esa línea no sale: un código no
 * le dice nada a la persona.
 */
export function proposedFindings(
  lines: BudgetPresentation["lines"],
  planItems: ReadonlyArray<Pick<PlanItem, "id" | "diagnosisCode" | "toothNumber">>,
  diagnoses: ReadonlyArray<Pick<PatientDiagnosis, "diagnosisCode" | "description">>,
  placeName: (tooth: number) => string | undefined = () => undefined,
): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of lines) {
    const item = planItems.find((row) => row.id === line.planItemId)
    const name = item?.diagnosisCode
      ? diagnoses.find((row) => row.diagnosisCode === item.diagnosisCode)?.description
      : null
    if (!item || !name) continue
    const place = item.toothNumber != null ? placeName(item.toothNumber) : undefined
    const text = place ? `${place}: ${name}.` : `${name}.`
    if (seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out.join("\n")
}

/**
 * «Revisar y enviar»: lo que le llega a la persona, antes de que le llegue. Lo
 * encontrado (solo a quien lee la clínica), lo propuesto, la vigencia, la
 * explicación de cada línea y las opciones; «Antes de enviar» avisa sin trabar.
 * Enviar y «Ver el PDF» guardan primero: un error no pierde lo escrito. Fuera
 * de borrador, lo entregado se ve y no cambia.
 */
export function BudgetReviewDrawer({
  patientId,
  budgetId,
  onClose,
  onSent,
  beforeSend,
}: {
  patientId: string
  budgetId: string
  onClose: () => void
  onSent?: () => void
  /** Lo que hay que guardar antes (el borrador de la atención). */
  beforeSend?: () => Promise<void>
}) {
  const queryClient = useQueryClient()
  const canWrite = usePermission("budgets.write")
  const canSend = usePermission("budgets.send")
  const canClinical = usePermission("clinical.read")
  const canEditService = usePermission("settings.write")
  const presentation = useQuery({
    queryKey: ["budget-presentation", patientId, budgetId],
    queryFn: () => fetchBudgetPresentation(patientId, budgetId),
    refetchOnWindowFocus: false,
  })
  const budget = useQuery({
    queryKey: ["budget", patientId, budgetId],
    queryFn: () => fetchBudgetDetail(patientId, budgetId),
  })
  // Los diagnósticos que ya conoce el Plan: los lee quien lee la clínica.
  const planItems = useQuery({
    queryKey: ["plan-items", patientId],
    queryFn: () => apiFetch<{ data: PlanItem[] }>(`/api/patients/${patientId}/plan`),
    enabled: canClinical,
  })
  const diagnoses = useQuery({
    queryKey: ["patient-diagnoses", patientId],
    queryFn: () => fetchPatientDiagnoses(patientId),
    enabled: canClinical,
  })
  const preview = useBudgetSendPreview(patientId, budgetId, presentation.data?.data.status === "borrador")
  const data = presentation.data?.data
  const editable = canWrite && data?.status === "borrador"

  // `undefined`: como está guardado. Lo escrito vive aquí y sobrevive a un error.
  const [findings, setFindings] = useState<string | undefined>(undefined)
  const [proposal, setProposal] = useState<string | undefined>(undefined)
  const [validUntil, setValidUntil] = useState<string | null | undefined>(undefined)
  const [options, setOptions] = useState<Record<string, OptionDraft>>({})
  /** El ajuste de cada línea: un texto propio o null para quitarlo. */
  const [lineGuides, setLineGuides] = useState<Record<string, PatientGuide | null>>({})
  const [openLine, setOpenLine] = useState<string | null>(null)
  const [viewingPdf, setViewingPdf] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pdfRevision, setPdfRevision] = useState(0)
  const requestId = useRef<string>(crypto.randomUUID())

  const proposedText = useMemo(
    () =>
      data && canClinical && !data.findings
        ? proposedFindings(data.lines, planItems.data?.data ?? [], diagnoses.data?.data ?? [], (tooth) =>
            productUi().site?.placeName(tooth),
          )
        : "",
    [data, canClinical, planItems.data, diagnoses.data],
  )
  const findingsValue = findings ?? data?.findings ?? proposedText
  const userEdited =
    findings !== undefined ||
    proposal !== undefined ||
    validUntil !== undefined ||
    Object.keys(options).length > 0 ||
    Object.keys(lineGuides).length > 0

  /** Solo lo que cambió: confirmar es también aceptar el texto propuesto de lo encontrado. */
  const pendingBody = (): BudgetPresentationBody | null => {
    if (!data || !editable) return null
    const body: BudgetPresentationBody = {}
    if (canClinical && findingsValue.trim() !== (data.findings ?? "")) body.findings = findingsValue.trim() || null
    if (proposal !== undefined && proposal.trim() !== (data.proposal ?? "")) body.proposal = proposal.trim() || null
    if (validUntil !== undefined && validUntil !== data.validUntil) body.validUntil = validUntil
    const optionRows = Object.entries(options).map(([optionId, draft]) => ({
      optionId,
      name: draft.name.trim() || null,
      pros: draft.pros.trim() || null,
      cons: draft.cons.trim() || null,
    }))
    if (optionRows.length > 0) body.options = optionRows
    const lineRows = Object.entries(lineGuides).map(([lineId, patientGuide]) => ({ lineId, patientGuide }))
    if (lineRows.length > 0) body.lines = lineRows
    return Object.keys(body).length > 0 ? body : null
  }

  const save = async () => {
    const body = pendingBody()
    if (!body) return
    const result = await updateBudgetPresentation(patientId, budgetId, body)
    queryClient.setQueryData(["budget-presentation", patientId, budgetId], result)
    setFindings(undefined)
    setProposal(undefined)
    setValidUntil(undefined)
    setOptions({})
    setLineGuides({})
    setOpenLine(null)
    setPdfRevision((value) => value + 1)
    await queryClient.invalidateQueries({ queryKey: ["budgets", patientId] })
  }

  const refresh = () =>
    Promise.all(
      [...PLAN_QUERY_KEYS, "budget-send-preview"].map((key) =>
        queryClient.invalidateQueries({ queryKey: [key, patientId] }),
      ),
    )

  const saveMutation = useMutation({
    mutationFn: save,
    onSuccess: () => {
      setError(null)
      setViewingPdf(true)
    },
    onError: (cause) => setError(mutationMessage(cause)),
  })
  const sendMutation = useMutation({
    mutationFn: async () => {
      await beforeSend?.()
      await save()
      return sendBudgetApi(patientId, budgetId, { requestId: requestId.current })
    },
    onSuccess: async (result) => {
      requestId.current = crypto.randomUUID()
      setError(null)
      toast.success(sentWords(result.data.recipientName, result.data.channel, result.data.via))
      await refresh()
      onSent?.()
      onClose()
    },
    onError: (cause) => setError(mutationMessage(cause)),
  })
  const saveOnly = useMutation({
    mutationFn: save,
    onSuccess: () => {
      setError(null)
      toast.success("Guardado")
      onClose()
    },
    onError: (cause) => setError(mutationMessage(cause)),
  })

  const blocked = preview.data?.data.blocked ?? null
  const sendable = canSend && data?.status === "borrador"
  const busy = sendMutation.isPending || saveMutation.isPending || saveOnly.isPending
  const missing = (data?.lines ?? []).filter(
    (line) => !(lineGuides[line.id] !== undefined ? lineGuides[line.id] : line.patientGuide ?? line.serviceGuide),
  )
  const serviceOf = (line: BudgetPresentation["lines"][number]) =>
    budget.data?.data.items.find((item) => item.planItemId === line.planItemId && item.optionId === line.optionId)
      ?.serviceId ?? null
  const dated = validUntil !== undefined ? validUntil : (data?.validUntil ?? null)
  const several = (data?.options.length ?? 0) > 1

  const optionDraft = (option: BudgetPresentation["options"][number]): OptionDraft =>
    options[option.id] ?? { name: option.name ?? "", pros: option.pros ?? "", cons: option.cons ?? "" }
  const changeOption = (option: BudgetPresentation["options"][number], patch: Partial<OptionDraft>) =>
    setOptions((current) => ({ ...current, [option.id]: { ...optionDraft(option), ...patch } }))

  return (
    <>
      <FormDrawer
        open
        dock={false}
        className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(48rem,calc(100vw-2rem))]"
        title={data?.status === "borrador" ? "Revisar y enviar" : "Lo que se le explicó"}
        description={budget.data ? `${budgetNumberLabel(budget.data.data.budgetNumber)} · ${budget.data.data.stateText}` : undefined}
        isSubmitting={busy}
        isDirty={userEdited}
        error={error}
        hideSubmit={!(sendable || editable)}
        cancelLabel={sendable || editable ? undefined : "Cerrar"}
        submitLabel={sendable ? (preview.data?.data.label ?? "Enviar") : "Guardar"}
        submitDisabled={sendable ? preview.isPending || blocked != null : false}
        secondaryAction={
          data
            ? {
                label: "Ver el PDF",
                disabled: busy,
                onClick: () => {
                  setError(null)
                  if (editable) saveMutation.mutate()
                  else setViewingPdf(true)
                },
              }
            : undefined
        }
        onClose={onClose}
        onSubmit={(event) => {
          event.preventDefault()
          setError(null)
          if (sendable) sendMutation.mutate()
          else if (editable) saveOnly.mutate()
        }}
      >
        {presentation.isError ? (
          <ErrorState
            title="No pudimos cargar el presupuesto"
            message={mutationMessage(presentation.error)}
            onRetry={() => void presentation.refetch()}
          />
        ) : !data ? (
          <div className="flex flex-col gap-3" role="status" aria-label="Cargando…">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <FieldGroup>
            {canClinical ? (
              <Field>
                <FieldLabel htmlFor="review-findings">Lo que encontramos</FieldLabel>
                <Textarea
                  id="review-findings"
                  rows={3}
                  maxLength={4000}
                  readOnly={!editable}
                  value={findingsValue}
                  onChange={(event) => setFindings(event.target.value)}
                />
                {editable && !data.findings && findings === undefined && proposedText ? (
                  <FieldDescription>
                    Armado con los diagnósticos de los tratamientos. Revísalo y escríbelo en palabras de la persona: se
                    guarda al enviar o al ver el PDF.
                  </FieldDescription>
                ) : null}
              </Field>
            ) : data.hasFindings ? (
              <p className="text-sm text-muted-foreground">
                «Lo que encontramos» lo escribe y lo lee quien atiende: esa parte no te corresponde.
              </p>
            ) : null}

            <Field>
              <FieldLabel htmlFor="review-proposal">Lo que le proponemos</FieldLabel>
              <Textarea
                id="review-proposal"
                rows={3}
                maxLength={4000}
                readOnly={!editable}
                value={proposal ?? data.proposal ?? ""}
                onChange={(event) => setProposal(event.target.value)}
              />
            </Field>

            <Field>
              <span className="text-sm font-medium">Vigente hasta</span>
              {editable ? (
                <DatePickerButton
                  aria-label="Vigente hasta"
                  value={dated ?? ""}
                  min={regionToday()}
                  emptyLabel="Sin fecha"
                  onChange={(value) => setValidUntil(value || null)}
                />
              ) : (
                <p className="text-sm">{dated ? formatDate(dated) : "Sin fecha"}</p>
              )}
            </Field>

            <FieldSet>
              <FieldLegend>Lo que se haría</FieldLegend>
              <ul className="flex flex-col divide-y rounded-lg border">
                {data.lines.map((line) => {
                  const own = lineGuides[line.id] !== undefined ? lineGuides[line.id] : line.patientGuide
                  const shown = own ?? line.serviceGuide
                  const editing = openLine === line.id
                  return (
                    <li key={line.id} className="flex flex-col gap-2 p-3 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="min-w-0 font-medium break-words">{line.title}</span>
                        {editable ? (
                          <div className="flex flex-wrap items-center gap-2">
                            {!editing ? (
                              <Button type="button" size="sm" variant="outline" onClick={() => setOpenLine(line.id)}>
                                Cambiar solo para este paciente
                              </Button>
                            ) : null}
                            {own ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setLineGuides((current) => ({ ...current, [line.id]: null }))
                                  setOpenLine(null)
                                }}
                              >
                                Quitar el ajuste
                              </Button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                      {editing ? (
                        <GuideFields
                          idPrefix={`linea-${line.id}`}
                          value={own ?? line.serviceGuide ?? {}}
                          onChange={(next) => setLineGuides((current) => ({ ...current, [line.id]: next }))}
                        />
                      ) : hasGuide(shown) ? (
                        <>
                          {own ? <span className="text-xs text-muted-foreground">Ajustado para este paciente</span> : null}
                          <GuideSummary guide={shown} />
                        </>
                      ) : (
                        <span className="text-muted-foreground">Sin explicación: sale solo con su nombre y precio.</span>
                      )}
                    </li>
                  )
                })}
              </ul>
            </FieldSet>

            {several
              ? data.options.map((option) => {
                  const draft = optionDraft(option)
                  return (
                    <FieldSet key={option.id}>
                      <FieldLegend>{option.label}</FieldLegend>
                      <FieldGroup>
                        <Field>
                          <FieldLabel htmlFor={`option-${option.id}-name`}>Nombre</FieldLabel>
                          <Input
                            id={`option-${option.id}-name`}
                            maxLength={120}
                            readOnly={!editable}
                            value={draft.name}
                            onChange={(event) => changeOption(option, { name: event.target.value })}
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor={`option-${option.id}-pros`}>A favor</FieldLabel>
                          <Textarea
                            id={`option-${option.id}-pros`}
                            rows={2}
                            maxLength={1000}
                            readOnly={!editable}
                            value={draft.pros}
                            onChange={(event) => changeOption(option, { pros: event.target.value })}
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor={`option-${option.id}-cons`}>A considerar</FieldLabel>
                          <Textarea
                            id={`option-${option.id}-cons`}
                            rows={2}
                            maxLength={1000}
                            readOnly={!editable}
                            value={draft.cons}
                            onChange={(event) => changeOption(option, { cons: event.target.value })}
                          />
                        </Field>
                      </FieldGroup>
                    </FieldSet>
                  )
                })
              : null}

            {data.status === "borrador" ? (
              <section aria-label="Antes de enviar" className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3 text-sm">
                <h3 className="font-medium">Antes de enviar</h3>
                <ul className="flex flex-col gap-1.5">
                  {dated ? null : <li>No tiene fecha de vigencia: el papel no dirá hasta cuándo vale.</li>}
                  {missing.map((line) => {
                    const serviceId = serviceOf(line)
                    return (
                      <li key={line.id}>
                        «{line.title}» no tiene explicación todavía.{" "}
                        {serviceId && canEditService ? (
                          <Link
                            to="/services"
                            search={{ q: line.title } as never}
                            className="font-medium text-primary underline-offset-4 hover:underline"
                          >
                            Ir al servicio
                          </Link>
                        ) : null}
                      </li>
                    )
                  })}
                  {dated && missing.length === 0 ? <li>Todo tiene su explicación y su fecha.</li> : null}
                  {blocked ? <li>{blocked}</li> : null}
                </ul>
                <p className="text-muted-foreground">
                  <strong className="font-medium text-foreground">Quién ve los diagnósticos.</strong> La propia persona y su
                  representante legal reciben el presupuesto completo. Si lo imprime quien no lee la historia o lo recibe
                  otra persona, sale sin «Lo que encontramos» ni las alergias.
                </p>
              </section>
            ) : null}
          </FieldGroup>
        )}
      </FormDrawer>
      {viewingPdf && budget.data ? (
        <DocumentPaperPanel
          patientId={patientId}
          type="budget"
          documentId={budgetId}
          title={budgetNumberLabel(budget.data.data.budgetNumber)}
          status="Lo mismo que recibirá en su PDF. Verlo no le envía nada."
          send={null}
          revision={`revision-${pdfRevision}`}
          onClose={() => setViewingPdf(false)}
        />
      ) : null}
    </>
  )
}

/** El botón «Revisar y enviar»: abre la revisión, sin enviar nada todavía. */
export function BudgetReviewButton({
  patientId,
  budgetId,
  label = "Revisar y enviar",
  size,
  variant,
  beforeOpen,
  onSent,
}: {
  patientId: string
  budgetId: string
  label?: string
  size?: React.ComponentProps<typeof Button>["size"]
  variant?: React.ComponentProps<typeof Button>["variant"]
  /** Lo que hay que guardar antes de leerlo (el borrador de la atención). */
  beforeOpen?: () => Promise<void>
  onSent?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <Button
        type="button"
        size={size}
        variant={variant}
        onClick={() => {
          setError(null)
          void Promise.resolve(beforeOpen?.())
            .then(() => setOpen(true))
            .catch((cause: unknown) => setError(mutationMessage(cause)))
        }}
      >
        {label}
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
      {open ? (
        <BudgetReviewDrawer
          patientId={patientId}
          budgetId={budgetId}
          beforeSend={beforeOpen}
          onSent={onSent}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}
