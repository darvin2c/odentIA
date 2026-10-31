import type { PatientGuide } from "@odentia/clinical"
import { Button, FieldGroup, FieldLegend, FieldSet, Skeleton, toast } from "@odentia/ui"
import {
  DatePickerButton,
  ErrorState,
  FormDrawer,
  regionToday,
  submitErrorMessage,
  submitForm,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useEffect, useMemo, useRef, useState } from "react"
import { z } from "zod"
import { apiFetch } from "../../../lib/api"
import {
  type BudgetPresentation,
  type BudgetPresentationBody,
  type BudgetWithTotals,
  budgetNumberLabel,
  fetchBudgetDetail,
  fetchBudgetPresentation,
  PLAN_QUERY_KEYS,
  sendBudgetApi,
  updateBudgetPresentation,
} from "../../../lib/budgets"
import { formatDate } from "../../../lib/clinical-journey"
import { usePermission } from "../../../lib/crm"
import { fetchPatientDiagnoses, type PatientDiagnosis } from "../../../lib/encounters"
import type { PlanItem } from "../../../lib/patients"
import { productUi } from "../../../product/product-ui"
import {
  type GuideDraft,
  GuideFields,
  GuideSummary,
  guideDraftOf,
  guideFromDraft,
  guideSchema,
  hasGuide,
  sameGuide,
} from "../../service-guide"
import { DocumentPaperPanel } from "../document-paper-panel"
import { useBudgetSendPreview } from "./budget-send"

/** Lo que dice el aviso cuando sale: la misma frase de `BudgetSendButton`. */
function sentWords(name: string, channel: "whatsapp" | "email", via: string): string {
  const where = channel === "whatsapp" ? "por WhatsApp" : "por correo"
  const first = name.trim().split(/\s+/)[0] ?? name
  return via === "plantilla"
    ? `Enviado a ${first} ${where}: le llega el aviso y, al tocarlo, el PDF`
    : `Enviado a ${first} ${where}, con el PDF`
}

const textLimit = (limit: number) =>
  z.string().max(limit, `Escribe como mucho ${limit} caracteres.`)

/** Los mismos límites que `budgetPresentationInput` de la API. */
const reviewSchema = z.object({
  findings: textLimit(4000),
  proposal: textLimit(4000),
  validUntil: z.string(),
  options: z.array(
    z.object({
      id: z.string(),
      name: textLimit(120),
      pros: textLimit(1000),
      cons: textLimit(1000),
    }),
  ),
  lines: z.array(z.object({ id: z.string(), own: guideSchema.nullable() })),
})
type ReviewValues = z.infer<typeof reviewSchema>

function valuesOf(data: BudgetPresentation): ReviewValues {
  return {
    findings: data.findings ?? "",
    proposal: data.proposal ?? "",
    validUntil: data.validUntil ?? "",
    options: data.options.map((option) => ({
      id: option.id,
      name: option.name ?? "",
      pros: option.pros ?? "",
      cons: option.cons ?? "",
    })),
    lines: data.lines.map((line) => ({
      id: line.id,
      own: line.patientGuide ? guideDraftOf(line.patientGuide) : null,
    })),
  }
}

/**
 * Solo lo que cambió. `findings` se compara con lo guardado: confirmar es también
 * aceptar el texto propuesto. Quien no lee la clínica nunca lo envía.
 */
export function reviewBody(
  data: BudgetPresentation,
  value: ReviewValues,
  canClinical: boolean,
): BudgetPresentationBody {
  const body: BudgetPresentationBody = {}
  if (canClinical && value.findings.trim() !== (data.findings ?? ""))
    body.findings = value.findings.trim() || null
  if (value.proposal.trim() !== (data.proposal ?? "")) body.proposal = value.proposal.trim() || null
  if (value.validUntil !== (data.validUntil ?? "")) body.validUntil = value.validUntil || null
  const options = value.options.filter((row) => {
    const saved = data.options.find((option) => option.id === row.id)
    return (
      row.name.trim() !== (saved?.name ?? "") ||
      row.pros.trim() !== (saved?.pros ?? "") ||
      row.cons.trim() !== (saved?.cons ?? "")
    )
  })
  if (options.length > 0) {
    body.options = options.map((row) => ({
      optionId: row.id,
      name: row.name.trim() || null,
      pros: row.pros.trim() || null,
      cons: row.cons.trim() || null,
    }))
  }
  const lines = value.lines.filter(
    (row) => !sameGuide(row.own, data.lines.find((line) => line.id === row.id)?.patientGuide),
  )
  if (lines.length > 0) {
    body.lines = lines.map((row) => ({
      lineId: row.id,
      patientGuide: row.own ? guideFromDraft(row.own) : null,
    }))
  }
  return body
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
 * Enviar y «Ver el PDF» guardan primero: un error no pierde lo escrito y se dice
 * en su campo. Fuera de borrador, lo entregado se ve y no cambia.
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
  const presentation = useQuery({
    queryKey: ["budget-presentation", patientId, budgetId],
    queryFn: () => fetchBudgetPresentation(patientId, budgetId),
    refetchOnWindowFocus: false,
  })
  const budget = useQuery({
    queryKey: ["budget", patientId, budgetId],
    queryFn: () => fetchBudgetDetail(patientId, budgetId),
  })
  const data = presentation.data?.data
  const budgetData = budget.data?.data
  if (data && budgetData) {
    return (
      <ReviewForm
        key={budgetId}
        patientId={patientId}
        budgetId={budgetId}
        data={data}
        budget={budgetData}
        onClose={onClose}
        onSent={onSent}
        beforeSend={beforeSend}
      />
    )
  }
  const failed = presentation.isError ? presentation.error : budget.isError ? budget.error : null
  return (
    <FormDrawer
      open
      dock={false}
      className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(48rem,calc(100vw-2rem))]"
      title="Revisar y enviar"
      hideSubmit
      cancelLabel="Cerrar"
      onClose={onClose}
      onSubmit={(event) => event.preventDefault()}
    >
      {failed ? (
        <ErrorState
          title="No pudimos cargar el presupuesto"
          message={submitErrorMessage(failed)}
          onRetry={() => {
            void presentation.refetch()
            void budget.refetch()
          }}
        />
      ) : (
        <div className="flex flex-col gap-3" role="status" aria-label="Cargando…">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}
    </FormDrawer>
  )
}

function ReviewForm({
  patientId,
  budgetId,
  data,
  budget,
  onClose,
  onSent,
  beforeSend,
}: {
  patientId: string
  budgetId: string
  data: BudgetPresentation
  budget: BudgetWithTotals
  onClose: () => void
  onSent?: () => void
  beforeSend?: () => Promise<void>
}) {
  const queryClient = useQueryClient()
  const canWrite = usePermission("budgets.write")
  const canSend = usePermission("budgets.send")
  const canClinical = usePermission("clinical.read")
  const canEditService = usePermission("settings.write")
  const draft = data.status === "borrador"
  const editable = canWrite && draft
  const sendable = canSend && draft
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
  const preview = useBudgetSendPreview(patientId, budgetId, draft)
  const blocked = preview.data?.data.blocked ?? null

  const requestId = useRef<string>(crypto.randomUUID())
  /** Qué sigue a guardar: enviar, ver el PDF o nada. */
  const intent = useRef<"send" | "pdf" | "save">("save")
  /** Qué fila del formulario es cada una de las que viajaron: el servidor las señala por su lugar. */
  const sent = useRef<{ options: number[]; lines: number[] }>({ options: [], lines: [] })
  const [openLine, setOpenLine] = useState<string | null>(null)
  const [viewingPdf, setViewingPdf] = useState(false)
  const [pdfRevision, setPdfRevision] = useState(0)

  const initial = useMemo(() => valuesOf(data), [data])
  const form = useAppForm({
    defaultValues: initial,
    validators: { onSubmit: reviewSchema },
    onSubmit: async ({ value }) => {
      const body = editable ? reviewBody(data, value, canClinical) : {}
      sent.current = {
        options: (body.options ?? []).map((row) =>
          value.options.findIndex((option) => option.id === row.optionId),
        ),
        lines: (body.lines ?? []).map((row) =>
          value.lines.findIndex((line) => line.id === row.lineId),
        ),
      }
      if (intent.current === "send") await beforeSend?.()
      if (Object.keys(body).length > 0) {
        const result = await updateBudgetPresentation(patientId, budgetId, body)
        queryClient.setQueryData(["budget-presentation", patientId, budgetId], result)
        setOpenLine(null)
        setPdfRevision((revision) => revision + 1)
        await queryClient.invalidateQueries({ queryKey: ["budgets", patientId] })
      }
      if (intent.current === "pdf") {
        setViewingPdf(true)
        return
      }
      if (intent.current === "send") {
        const result = await sendBudgetApi(patientId, budgetId, { requestId: requestId.current })
        requestId.current = crypto.randomUUID()
        toast.success(sentWords(result.data.recipientName, result.data.channel, result.data.via))
        await Promise.all(
          [...PLAN_QUERY_KEYS, "budget-send-preview"].map((key) =>
            queryClient.invalidateQueries({ queryKey: [key, patientId] }),
          ),
        )
        onSent?.()
      } else {
        toast.success("Guardado")
      }
      onClose()
    },
  })
  /** `lines[0].patientGuide.how` del cuerpo → la fila del formulario donde se escribió. */
  const fieldMap = (serverField: string): string | undefined => {
    const line = /^lines\[(\d+)\]\.patientGuide\.?(.*)$/.exec(serverField)
    if (line) {
      const at = sent.current.lines[Number(line[1])]
      return at === undefined ? undefined : `lines[${at}].own${line[2] ? `.${line[2]}` : ""}`
    }
    const option = /^options\[(\d+)\]\.(.+)$/.exec(serverField)
    if (option) {
      const at = sent.current.options[Number(option[1])]
      return at === undefined ? undefined : `options[${at}].${option[2]}`
    }
    return undefined
  }
  const surface = useFormSurface(form, { fieldMap })

  // Lo encontrado vacío se propone con los diagnósticos, una vez y sin contar como cambio.
  const proposedText = useMemo(
    () =>
      draft && canClinical && !data.findings
        ? proposedFindings(
            data.lines,
            planItems.data?.data ?? [],
            diagnoses.data?.data ?? [],
            (tooth) => productUi().site?.placeName(tooth),
          )
        : "",
    [draft, canClinical, data, planItems.data, diagnoses.data],
  )
  const [proposedTaken, setProposedTaken] = useState(false)
  useEffect(() => {
    if (proposedTaken || !proposedText || form.state.values.findings) return
    form.setFieldValue("findings", proposedText, { dontUpdateMeta: true })
    setProposedTaken(true)
  }, [proposedText, proposedTaken, form])

  const findingsValue = useStore(form.store, (state) => state.values.findings)
  const dated = useStore(form.store, (state) => state.values.validUntil)
  const lineValues = useStore(form.store, (state) => state.values.lines)
  const several = data.options.length > 1
  const busy = surface.isSubmitting

  const ownOf = (lineId: string): GuideDraft | null =>
    lineValues.find((row) => row.id === lineId)?.own ?? null
  const shownGuide = (line: BudgetPresentation["lines"][number]): PatientGuide | null => {
    const own = ownOf(line.id)
    return (own ? guideFromDraft(own) : null) ?? line.serviceGuide
  }
  const missing = data.lines.filter((line) => !shownGuide(line))
  const serviceOf = (line: BudgetPresentation["lines"][number]) =>
    budget.items.find(
      (item) => item.planItemId === line.planItemId && item.optionId === line.optionId,
    )?.serviceId ?? null

  return (
    <>
      <FormDrawer
        {...surface}
        open
        dock={false}
        className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(48rem,calc(100vw-2rem))]"
        title={draft ? "Revisar y enviar" : "Lo que se le explicó"}
        description={`${budgetNumberLabel(budget.budgetNumber)} · ${budget.stateText}`}
        hideSubmit={!(sendable || editable)}
        cancelLabel={sendable || editable ? undefined : "Cerrar"}
        submitLabel={sendable ? (preview.data?.data.label ?? "Enviar") : "Guardar"}
        submitDisabled={sendable ? preview.isPending || blocked != null : false}
        secondaryAction={{
          label: "Ver el PDF",
          disabled: busy,
          onClick: () => {
            if (!editable) {
              setViewingPdf(true)
              return
            }
            intent.current = "pdf"
            void submitForm(form, { fieldMap })
          },
        }}
        onClose={onClose}
        onSubmit={(event) => {
          intent.current = sendable ? "send" : "save"
          surface.onSubmit(event)
        }}
      >
        <FieldGroup>
          {canClinical ? (
            <form.AppField name="findings">
              {(field) => (
                <field.TextareaField
                  id="review-findings"
                  label="Lo que encontramos"
                  rows={3}
                  maxLength={4000}
                  readOnly={!editable}
                  description={
                    editable && !data.findings && proposedTaken && findingsValue === proposedText
                      ? "Armado con los diagnósticos de los tratamientos. Revísalo y escríbelo en palabras de la persona: se guarda al enviar o al ver el PDF."
                      : undefined
                  }
                />
              )}
            </form.AppField>
          ) : data.hasFindings ? (
            <p className="text-sm text-muted-foreground">
              «Lo que encontramos» lo escribe y lo lee quien atiende: esa parte no te corresponde.
            </p>
          ) : null}

          <form.AppField name="proposal">
            {(field) => (
              <field.TextareaField
                id="review-proposal"
                label="Lo que le proponemos"
                rows={3}
                maxLength={4000}
                readOnly={!editable}
              />
            )}
          </form.AppField>

          {editable ? (
            <form.AppField name="validUntil">
              {(field) => (
                <field.Control label="Vigente hasta">
                  {(control) => (
                    <DatePickerButton
                      {...control.props}
                      value={field.state.value}
                      min={regionToday()}
                      emptyLabel="Sin fecha"
                      onChange={field.handleChange}
                    />
                  )}
                </field.Control>
              )}
            </form.AppField>
          ) : (
            <div className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Vigente hasta</span>
              <span>{dated ? formatDate(dated) : "Sin fecha"}</span>
            </div>
          )}

          <FieldSet>
            <FieldLegend>Lo que se haría</FieldLegend>
            <ul className="flex flex-col divide-y rounded-lg border">
              {data.lines.map((line, index) => {
                const own = ownOf(line.id)
                const shown = shownGuide(line)
                const editing = openLine === line.id
                return (
                  <li key={line.id} className="flex flex-col gap-2 p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 font-medium break-words">
                        {line.title}
                        {several ? (
                          <span className="font-normal text-muted-foreground">
                            {" "}
                            · {data.options.find((option) => option.id === line.optionId)?.label}
                          </span>
                        ) : null}
                      </span>
                      {editable ? (
                        <div className="flex flex-wrap items-center gap-2">
                          {!editing ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                if (!own) {
                                  form.setFieldValue(
                                    `lines[${index}].own`,
                                    guideDraftOf(line.serviceGuide),
                                  )
                                }
                                setOpenLine(line.id)
                              }}
                            >
                              Cambiar solo para este paciente
                            </Button>
                          ) : null}
                          {own ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                form.setFieldValue(`lines[${index}].own`, null)
                                setOpenLine(null)
                              }}
                            >
                              Quitar el ajuste
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    {editing && own ? (
                      <GuideFields
                        form={form}
                        fields={`lines[${index}].own` as never}
                        idPrefix={`linea-${line.id}`}
                      />
                    ) : hasGuide(shown) ? (
                      <>
                        {own ? (
                          <span className="text-xs text-muted-foreground">
                            Ajustado para este paciente
                          </span>
                        ) : null}
                        <GuideSummary guide={shown} />
                      </>
                    ) : (
                      <span className="text-muted-foreground">
                        Sin explicación: sale solo con su nombre y precio.
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          </FieldSet>

          {several
            ? data.options.map((option, index) => (
                <FieldSet key={option.id}>
                  <FieldLegend>{option.label}</FieldLegend>
                  <FieldGroup>
                    <form.AppField name={`options[${index}].name`}>
                      {(field) => (
                        <field.TextField label="Nombre" maxLength={120} readOnly={!editable} />
                      )}
                    </form.AppField>
                    <form.AppField name={`options[${index}].pros`}>
                      {(field) => (
                        <field.TextareaField
                          label="A favor"
                          rows={2}
                          maxLength={1000}
                          readOnly={!editable}
                        />
                      )}
                    </form.AppField>
                    <form.AppField name={`options[${index}].cons`}>
                      {(field) => (
                        <field.TextareaField
                          label="A considerar"
                          rows={2}
                          maxLength={1000}
                          readOnly={!editable}
                        />
                      )}
                    </form.AppField>
                  </FieldGroup>
                </FieldSet>
              ))
            : null}

          {draft ? (
            <section
              aria-label="Antes de enviar"
              className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3 text-sm"
            >
              <h3 className="font-medium">Antes de enviar</h3>
              <ul className="flex flex-col gap-1.5">
                {dated ? null : (
                  <li>No tiene fecha de vigencia: el papel no dirá hasta cuándo vale.</li>
                )}
                {missing.map((line) => (
                  <li key={line.id}>
                    «{line.title}» no tiene explicación todavía.{" "}
                    {serviceOf(line) && canEditService ? (
                      <Link
                        to="/services"
                        search={{ q: line.title } as never}
                        className="font-medium text-primary underline-offset-4 hover:underline"
                      >
                        Ir al servicio
                      </Link>
                    ) : null}
                  </li>
                ))}
                {dated && missing.length === 0 ? (
                  <li>Todo tiene su explicación y su fecha.</li>
                ) : null}
                {blocked ? <li>{blocked}</li> : null}
              </ul>
              <p className="text-muted-foreground">
                <strong className="font-medium text-foreground">Quién ve los diagnósticos.</strong>{" "}
                La propia persona y su representante legal reciben el presupuesto completo. Si lo
                imprime quien no lee la historia o lo recibe otra persona, sale sin «Lo que
                encontramos» ni las alergias.
              </p>
            </section>
          ) : null}
        </FieldGroup>
      </FormDrawer>
      {viewingPdf ? (
        <DocumentPaperPanel
          patientId={patientId}
          type="budget"
          documentId={budgetId}
          title={budgetNumberLabel(budget.budgetNumber)}
          status="Lo mismo que recibirá en su PDF. Verlo no le envía nada."
          send={null}
          revision={`revision-${pdfRevision}`}
          onClose={() => setViewingPdf(false)}
        />
      ) : null}
    </>
  )
}
