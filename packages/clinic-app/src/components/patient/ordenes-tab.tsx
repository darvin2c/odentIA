import { appWords } from "../../lib/product-words"
import { diagnosisCodeLabel } from "@odentia/clinical"
import { Badge, Button, buttonVariants, Input, toast } from "@odentia/ui"
import { FormDrawer, RowActions, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useRef, useState } from "react"
import { z } from "zod"
import {
  advanceOrder,
  type ClinicalOrder,
  type ClinicalOrderKind,
  createOrder,
  fetchSpecialties,
  ORDER_KIND_LABELS,
  ORDER_KIND_TITLES,
  ORDER_STATUS_LABELS,
} from "../../lib/clinical-forms"
import { useMyUserId, useOrgMembers } from "../../lib/crm"
import { uploadPatientFile } from "../../lib/encounter-documents"
import { DiagnosisSearch } from "./diagnosis-search"
import { HealthDocumentSendDrawer } from "./health-document-send"

function statusVariant(status: ClinicalOrder["status"]): "default" | "secondary" | "success" | "destructive" {
  if (status === "completado") return "success"
  if (status === "cancelado") return "destructive"
  if (status === "en_proceso") return "default"
  return "secondary"
}

/**
 * Una orden en una fila: qué es, para quién, su estado y su única acción
 * («Imprimir»); lo demás (enviar, subir el resultado, cancelar) va en el menú.
 */
export function OrderRow({
  order,
  canWrite,
  onChanged,
}: {
  order: ClinicalOrder
  canWrite: boolean
  onChanged: () => void
}): React.JSX.Element {
  const [sending, setSending] = useState(false)
  const [resultOpen, setResultOpen] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const open = order.status === "solicitado" || order.status === "en_proceso"
  const items = [
    ...(order.status !== "cancelado"
      ? [{ key: "send", label: "Enviar a la persona", onSelect: () => setSending(true) }]
      : []),
    ...(canWrite && open
      ? [
          { key: "result", label: "Subir el resultado", onSelect: () => setResultOpen(true) },
          { key: "cancel", label: "Cancelar…", tone: "danger" as const, onSelect: () => setCancelOpen(true) },
        ]
      : []),
  ]
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="flex min-w-0 flex-col">
        <p className="text-sm font-medium">
          {ORDER_KIND_TITLES[order.kind]} · {order.title}
        </p>
        <p className="text-sm text-muted-foreground">
          {ORDER_STATUS_LABELS[order.status]}
          {order.diagnosisCode ? ` · ${diagnosisCodeLabel(order.diagnosisSystem, order.diagnosisCode)}` : ""} · para {order.recipient}
          {order.detail ? ` · ${order.detail}` : ""}
        </p>
        {order.status === "completado" && order.resultText ? (
          <p className="mt-1 text-sm">
            <strong>Resultado:</strong> {order.resultText}
          </p>
        ) : null}
        {order.status === "completado" && order.resultDocumentId ? (
          <p className="text-xs text-muted-foreground">El resultado quedó en Documentos.</p>
        ) : null}
        {order.status === "cancelado" && order.cancelReason ? (
          <p className="text-xs text-muted-foreground">Cancelada: {order.cancelReason}</p>
        ) : null}
      </div>
      <div className="flex items-center gap-1">
        <Badge variant={statusVariant(order.status)}>{ORDER_STATUS_LABELS[order.status]}</Badge>
        {order.status !== "cancelado" ? (
          <Link
            to="/patients/$patientId/orders/$orderId/print"
            params={{ patientId: order.patientId, orderId: order.id }}
            target="_blank"
            className={buttonVariants({ size: "sm", variant: "outline" })}
          >
            Imprimir
          </Link>
        ) : null}
        {items.length > 0 ? <RowActions label={`Acciones de ${order.title}`} items={items} /> : null}
      </div>
      {sending ? (
        <HealthDocumentSendDrawer
          open
          patientId={order.patientId}
          documentType="order"
          documentId={order.id}
          onClose={() => setSending(false)}
        />
      ) : null}
      {resultOpen ? (
        <OrderResultDrawer order={order} onClose={() => setResultOpen(false)} onSaved={onChanged} />
      ) : null}
      {cancelOpen ? (
        <OrderCancelDrawer order={order} onClose={() => setCancelOpen(false)} onSaved={onChanged} />
      ) : null}
    </div>
  )
}

/** El resultado se sube a la propia orden: el archivo, el texto o ambos. */
const resultSchema = z
  .object({
    file: z.custom<File | null>(),
    text: z.string().max(10000, "Escribe como mucho 10000 caracteres."),
  })
  .superRefine((value, ctx) => {
    if (!value.file && !value.text.trim())
      ctx.addIssue({ code: "custom", path: ["file"], message: "Sube el archivo o escribe el resultado" })
  })

export function OrderResultDrawer({
  order,
  onClose,
  onSaved,
}: {
  order: ClinicalOrder
  onClose: () => void
  onSaved: () => void
}) {
  // El archivo ya subido no se sube otra vez si lo que falla es guardar el resultado.
  const uploaded = useRef<{ file: File; id: string } | null>(null)
  const save = useMutation({
    mutationFn: (body: { resultText: string | null; resultDocumentId: string | null }) =>
      advanceOrder(order.id, { toStatus: "completado", ...body }),
  })
  const form = useAppForm({
    defaultValues: { file: null as File | null, text: "" },
    validators: { onSubmit: resultSchema },
    onSubmit: async ({ value }) => {
      let resultDocumentId: string | null = null
      if (value.file) {
        resultDocumentId = uploaded.current?.file === value.file ? uploaded.current.id : null
        if (!resultDocumentId) {
          const document = await uploadPatientFile(order.patientId, value.file, {
            category: order.kind === "imagen" ? "radiografia" : "informe",
            imageType: null,
            label: `Resultado: ${order.title}`,
          })
          uploaded.current = { file: value.file, id: document.id }
          resultDocumentId = document.id
        }
      }
      await save.mutateAsync({ resultText: value.text.trim() || null, resultDocumentId })
      toast.success("Resultado guardado en la orden")
      onSaved()
      onClose()
    },
  })
  const surface = useFormSurface(form, { fieldMap: { resultDocumentId: "file", resultText: "text" } })
  return (
    <FormDrawer
      {...surface}
      open
      onClose={() => {
        if (!surface.isSubmitting) onClose()
      }}
      title="Subir el resultado"
      description={`${ORDER_KIND_TITLES[order.kind]} · ${order.title}`}
      submitLabel="Guardar resultado"
    >
      <div className="flex flex-col gap-4">
        <form.AppField name="file">
          {(field) => (
            <field.Control label="Archivo del resultado" description="Queda en Documentos, unido a esta orden.">
              {(control) => (
                <Input
                  {...control.props}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  onChange={(event) => field.handleChange(event.target.files?.[0] ?? null)}
                />
              )}
            </field.Control>
          )}
        </form.AppField>
        <form.AppField name="text">
          {(field) => <field.TextareaField label="Resultado escrito (opcional)" rows={3} maxLength={10000} />}
        </form.AppField>
      </div>
    </FormDrawer>
  )
}

const cancelSchema = z.object({
  reason: z.string().trim().min(1, "Escribe el motivo").max(2000, "Escribe como mucho 2000 caracteres."),
})

function OrderCancelDrawer({
  order,
  onClose,
  onSaved,
}: {
  order: ClinicalOrder
  onClose: () => void
  onSaved: () => void
}) {
  const cancel = useMutation({
    mutationFn: (reason: string) => advanceOrder(order.id, { toStatus: "cancelado", reason }),
  })
  const form = useAppForm({
    defaultValues: { reason: "" },
    validators: { onSubmit: cancelSchema },
    onSubmit: async ({ value }) => {
      await cancel.mutateAsync(value.reason.trim())
      toast.success("Orden cancelada")
      onSaved()
      onClose()
    },
  })
  const surface = useFormSurface(form)
  return (
    <FormDrawer
      {...surface}
      open
      dock={false}
      onClose={() => {
        if (!surface.isSubmitting) onClose()
      }}
      title="Cancelar la orden"
      description="Queda en la historia como cancelada, con tu nombre y el motivo."
      submitLabel="Cancelar la orden"
    >
      <form.AppField name="reason">
        {(field) => (
          <field.TextareaField
            label="Motivo"
            rows={2}
            maxLength={2000}
            aria-required
            placeholder="Ej.: ya trajo el examen hecho"
          />
        )}
      </form.AppField>
    </FormDrawer>
  )
}

const ORDER_KINDS = Object.keys(ORDER_KIND_LABELS) as ClinicalOrderKind[]

interface NewOrderValues {
  kind: ClinicalOrderKind
  title: string
  colleagueId: string
  recipient: string
  diagnosisCode: string
  diagnosisSystem: string | null
  specialtyId: string
  detail: string
}

/** Los mismos límites que `orderCreate` de la API. */
const newOrderSchema = z
  .object({
    kind: z.custom<ClinicalOrderKind>(),
    title: z.string().trim().min(1, "Escribe qué se pide").max(200, "Escribe como mucho 200 caracteres."),
    colleagueId: z.string(),
    recipient: z.string().trim().max(200, "Escribe como mucho 200 caracteres."),
    diagnosisCode: z.string(),
    diagnosisSystem: z.string().nullable(),
    specialtyId: z.string(),
    detail: z.string().trim().max(5000, "Escribe como mucho 5000 caracteres."),
  })
  .superRefine((value, ctx) => {
    if (!(value.kind === "interconsulta" && value.colleagueId) && !value.recipient.trim())
      ctx.addIssue({ code: "custom", path: ["recipient"], message: "Indica para quién es la orden" })
  })

/** El ejemplo de cada orden, con lo que se pide en el producto de la app. */
function kindPlaceholder(kind: ClinicalOrderKind): string {
  const { examples } = appWords()
  if (kind === "imagen") return `p. ej. ${examples.imagingOrder}`
  if (kind === "interconsulta") return `p. ej. ${examples.referral}`
  return "p. ej. Hemograma completo"
}

/**
 * Nueva orden: tipo, qué se pide, para quién (un centro, un laboratorio, otro
 * profesional o un colega de la clínica) y el diagnóstico que la motiva, que
 * desde la atención viene puesto. «Crear y entregar» termina en imprimir o
 * enviar.
 */
export function NewOrderDrawer({
  open,
  patientId,
  encounterId,
  defaultDiagnosisCode,
  defaultDiagnosisSystem,
  defaultKind = "imagen",
  onClose,
  onCreated,
}: {
  open: boolean
  patientId: string
  encounterId?: string
  /** Desde la atención: su diagnóstico. Si no se elige, el servidor toma el primero. */
  defaultDiagnosisCode?: string
  defaultDiagnosisSystem?: string
  defaultKind?: ClinicalOrderKind
  onClose: () => void
  onCreated: (order: ClinicalOrder) => void
}): React.JSX.Element {
  const myUserId = useMyUserId()
  const members = useOrgMembers()
  const [created, setCreated] = useState<ClinicalOrder | null>(null)
  const [sending, setSending] = useState(false)

  const specialtiesQuery = useQuery({
    queryKey: ["specialties-active"],
    queryFn: () => fetchSpecialties({ activeOnly: true }),
    enabled: open,
  })
  // Un colega es quien atiende en la clínica (el servidor lo vuelve a comprobar).
  const colleagues = members.filter(
    (m) => m.userId !== myUserId && ["clinician", "owner", "admin"].includes(m.role),
  )

  const createMutation = useMutation({ mutationFn: createOrder })
  const defaultValues: NewOrderValues = {
    kind: defaultKind,
    title: "",
    colleagueId: "",
    recipient: "",
    diagnosisCode: defaultDiagnosisCode ?? "",
    diagnosisSystem: defaultDiagnosisSystem ?? null,
    specialtyId: "",
    detail: "",
  }
  const form = useAppForm({
    defaultValues,
    validators: { onSubmit: newOrderSchema },
    onSubmit: async ({ value }) => {
      const toColleague = value.kind === "interconsulta" && Boolean(value.colleagueId)
      const result = await createMutation.mutateAsync({
        kind: value.kind,
        specialtyId: value.specialtyId || null,
        patientId,
        encounterId: encounterId ?? null,
        recipient: toColleague ? null : value.recipient.trim() || null,
        recipientUserId: toColleague ? value.colleagueId : null,
        title: value.title.trim(),
        detail: value.detail.trim() || null,
        diagnosisCode: value.diagnosisCode || null,
        diagnosisSystem: value.diagnosisCode ? value.diagnosisSystem : null,
      })
      toast.success(
        result.data.recipientUserId ? `Orden creada: ${result.data.recipient} recibió la tarea` : "Orden creada",
      )
      setCreated(result.data)
    },
  })
  const surface = useFormSurface(form, { fieldMap: { recipientUserId: "colleagueId" } })
  const kind = useStore(form.store, (state) => state.values.kind)
  const colleagueId = useStore(form.store, (state) => state.values.colleagueId)
  const diagnosisSystem = useStore(form.store, (state) => state.values.diagnosisSystem)

  if (created) {
    return (
      <>
        <FormDrawer
          open={open && !sending}
          onClose={() => onCreated(created)}
          title="Entregar la orden"
          description={`${ORDER_KIND_TITLES[created.kind]} · ${created.title}`}
          hideSubmit
          cancelLabel="Listo"
          onSubmit={(event) => event.preventDefault()}
        >
          <div className="flex flex-col gap-3">
            <p className="text-sm">Imprímela para entregarla en mano o envíasela a la persona.</p>
            <div className="flex flex-wrap gap-2">
              <Link
                to="/patients/$patientId/orders/$orderId/print"
                params={{ patientId, orderId: created.id }}
                target="_blank"
                className={buttonVariants({ variant: "default" })}
              >
                Imprimir
              </Link>
              <Button type="button" variant="outline" onClick={() => setSending(true)}>
                Enviar a la persona
              </Button>
            </div>
          </div>
        </FormDrawer>
        {sending ? (
          <HealthDocumentSendDrawer
            open
            patientId={patientId}
            documentType="order"
            documentId={created.id}
            onClose={() => {
              setSending(false)
              onCreated(created)
            }}
          />
        ) : null}
      </>
    )
  }

  return (
    <FormDrawer {...surface} open={open} onClose={onClose} title="Nueva orden" submitLabel="Crear y entregar">
      <div className="flex flex-col gap-4">
        <form.AppField
          name="kind"
          listeners={{ onChange: () => form.setFieldValue("colleagueId", "") }}
        >
          {(field) => (
            <field.SelectField
              label="Tipo"
              options={ORDER_KINDS.map((value) => ({ value, label: ORDER_KIND_LABELS[value] }))}
            />
          )}
        </form.AppField>
        <form.AppField name="title">
          {(field) => <field.TextField label="Qué se pide" maxLength={200} placeholder={kindPlaceholder(kind)} />}
        </form.AppField>
        {kind === "interconsulta" && colleagues.length > 0 ? (
          <form.AppField name="colleagueId">
            {(field) => (
              <field.SelectField
                label="Colega de la clínica"
                description="Un colega de la clínica recibe la tarea con la persona a la vista."
                options={[
                  { value: "", label: "Otro profesional (fuera de la clínica)" },
                  ...colleagues.map((m) => ({ value: m.userId, label: m.user.name })),
                ]}
              />
            )}
          </form.AppField>
        ) : null}
        {!(kind === "interconsulta" && colleagueId) ? (
          <form.AppField name="recipient">
            {(field) => (
              <field.TextField
                label="Para"
                maxLength={200}
                placeholder={
                  kind === "imagen"
                    ? "p. ej. Centro de imágenes"
                    : kind === "laboratorio"
                      ? "p. ej. Laboratorio Central"
                      : "p. ej. Dra. Pérez, cirujana maxilofacial"
                }
              />
            )}
          </form.AppField>
        ) : null}
        <form.AppField name="diagnosisCode">
          {(field) => (
            <field.Control label="Diagnóstico que la motiva">
              {(control) => (
                <DiagnosisSearch
                  id={control.id}
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  onBlur={control.onBlur}
                  value={field.state.value}
                  system={diagnosisSystem}
                  onChange={(code, _description, system) => {
                    form.setFieldValue("diagnosisSystem", system)
                    field.handleChange(code)
                  }}
                />
              )}
            </field.Control>
          )}
        </form.AppField>
        {kind === "interconsulta" ? (
          <form.AppField name="specialtyId">
            {(field) => (
              <field.SelectField
                label="Especialidad"
                placeholder="Sin especialidad"
                options={[
                  { value: "", label: "Sin especialidad" },
                  ...(specialtiesQuery.data?.data ?? []).map((s) => ({ value: s.id, label: s.name })),
                ]}
              />
            )}
          </form.AppField>
        ) : null}
        <form.AppField name="detail">
          {(field) => <field.TextareaField label="Detalle (opcional)" rows={3} maxLength={5000} />}
        </form.AppField>
      </div>
    </FormDrawer>
  )
}
