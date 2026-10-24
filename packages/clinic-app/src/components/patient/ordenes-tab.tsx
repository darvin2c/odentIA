import { appWords } from "../../lib/product-words"
import { diagnosisCodeLabel } from "@odentia/clinical"
import {
  Badge,
  Button,
  buttonVariants,
  Field,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  toast,
} from "@odentia/ui"
import { FormDrawer, RowActions } from "@odentia/ui-patterns"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useId, useState } from "react"
import { ApiError } from "../../lib/api"
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

const errorMessage = (e: unknown, fallback = "No se pudo completar la acción") =>
  e instanceof ApiError ? (e.shape.message ?? fallback) : e instanceof Error ? e.message : fallback

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
export function OrderResultDrawer({
  order,
  onClose,
  onSaved,
}: {
  order: ClinicalOrder
  onClose: () => void
  onSaved: () => void
}) {
  const ids = useId()
  const [file, setFile] = useState<File | null>(null)
  const [text, setText] = useState("")
  const [error, setError] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: async () => {
      const uploaded = file
        ? await uploadPatientFile(order.patientId, file, {
            category: order.kind === "imagen" ? "radiografia" : "informe",
            imageType: null,
            label: `Resultado: ${order.title}`,
          })
        : null
      return advanceOrder(order.id, {
        toStatus: "completado",
        resultText: text.trim() || null,
        resultDocumentId: uploaded?.id ?? null,
      })
    },
    onSuccess: () => {
      toast.success("Resultado guardado en la orden")
      onSaved()
      onClose()
    },
    onError: (e) => setError(errorMessage(e, "No se pudo guardar el resultado")),
  })
  return (
    <FormDrawer
      open
      onClose={() => {
        if (!save.isPending) onClose()
      }}
      title="Subir el resultado"
      description={`${ORDER_KIND_TITLES[order.kind]} · ${order.title}`}
      isSubmitting={save.isPending}
      error={error}
      submitLabel="Guardar resultado"
      onSubmit={(event) => {
        event.preventDefault()
        if (!file && !text.trim()) {
          setError("Sube el archivo o escribe el resultado")
          return
        }
        setError(null)
        save.mutate()
      }}
    >
      <div className="flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor={`${ids}-file`}>Archivo del resultado</FieldLabel>
          <Input
            id={`${ids}-file`}
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          <p className="text-xs text-muted-foreground">Queda en Documentos, unido a esta orden.</p>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${ids}-text`}>Resultado escrito (opcional)</FieldLabel>
          <Textarea
            id={`${ids}-text`}
            rows={3}
            maxLength={10000}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </Field>
      </div>
    </FormDrawer>
  )
}

function OrderCancelDrawer({
  order,
  onClose,
  onSaved,
}: {
  order: ClinicalOrder
  onClose: () => void
  onSaved: () => void
}) {
  const ids = useId()
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const cancel = useMutation({
    mutationFn: () => advanceOrder(order.id, { toStatus: "cancelado", reason: reason.trim() }),
    onSuccess: () => {
      toast.success("Orden cancelada")
      onSaved()
      onClose()
    },
    onError: (e) => setError(errorMessage(e, "No se pudo cancelar")),
  })
  return (
    <FormDrawer
      open
      dock={false}
      onClose={() => {
        if (!cancel.isPending) onClose()
      }}
      title="Cancelar la orden"
      description="Queda en la historia como cancelada, con tu nombre y el motivo."
      isSubmitting={cancel.isPending}
      error={error}
      submitLabel="Cancelar la orden"
      onSubmit={(event) => {
        event.preventDefault()
        if (!reason.trim()) {
          setError("Escribe el motivo")
          return
        }
        cancel.mutate()
      }}
    >
      <Field>
        <FieldLabel htmlFor={`${ids}-reason`}>Motivo</FieldLabel>
        <Textarea
          id={`${ids}-reason`}
          rows={2}
          maxLength={2000}
          value={reason}
          placeholder="Ej.: ya trajo el examen hecho"
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
    </FormDrawer>
  )
}

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
  const ids = useId()
  const myUserId = useMyUserId()
  const members = useOrgMembers()
  const [kind, setKind] = useState<ClinicalOrderKind>(defaultKind)
  const [specialtyId, setSpecialtyId] = useState("")
  const [recipient, setRecipient] = useState("")
  const [colleagueId, setColleagueId] = useState("")
  const [title, setTitle] = useState("")
  const [detail, setDetail] = useState("")
  const [diagnosisCode, setDiagnosisCode] = useState(defaultDiagnosisCode ?? "")
  const [diagnosisSystem, setDiagnosisSystem] = useState<string | null>(defaultDiagnosisSystem ?? null)
  const [error, setError] = useState<string | null>(null)
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

  const createMutation = useMutation({
    mutationFn: () =>
      createOrder({
        kind,
        specialtyId: specialtyId || null,
        patientId,
        encounterId: encounterId ?? null,
        recipient: kind === "interconsulta" && colleagueId ? null : recipient.trim() || null,
        recipientUserId: kind === "interconsulta" && colleagueId ? colleagueId : null,
        title: title.trim(),
        detail: detail.trim() || null,
        diagnosisCode: diagnosisCode || null,
        diagnosisSystem: diagnosisCode ? diagnosisSystem : null,
      }),
    onSuccess: (result) => {
      toast.success(
        result.data.recipientUserId ? `Orden creada: ${result.data.recipient} recibió la tarea` : "Orden creada",
      )
      setCreated(result.data)
    },
    onError: (e) => setError(errorMessage(e)),
  })

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
    <FormDrawer
      open={open}
      onClose={onClose}
      title="Nueva orden"
      isSubmitting={createMutation.isPending}
      error={error}
      submitLabel="Crear y entregar"
      isDirty={Boolean(title || recipient || detail)}
      onSubmit={(event) => {
        event.preventDefault()
        if (!title.trim()) {
          setError("Escribe qué se pide")
          return
        }
        if (!(kind === "interconsulta" && colleagueId) && !recipient.trim()) {
          setError("Indica para quién es la orden")
          return
        }
        setError(null)
        createMutation.mutate()
      }}
    >
      <div className="flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor={`${ids}-kind`}>Tipo</FieldLabel>
          <Select
            items={ORDER_KIND_LABELS}
            value={kind}
            onValueChange={(v) => {
              setKind((v as ClinicalOrderKind) ?? "imagen")
              setColleagueId("")
            }}
          >
            <SelectTrigger id={`${ids}-kind`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(ORDER_KIND_LABELS) as ClinicalOrderKind[]).map((value) => (
                <SelectItem key={value} value={value}>
                  {ORDER_KIND_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${ids}-title`}>Qué se pide</FieldLabel>
          <Input
            id={`${ids}-title`}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={200}
            placeholder={kindPlaceholder(kind)}
          />
        </Field>
        {kind === "interconsulta" && colleagues.length > 0 ? (
          <Field>
            <FieldLabel htmlFor={`${ids}-colleague`}>Colega de la clínica</FieldLabel>
            <Select
              items={Object.fromEntries([["", "Otro profesional (fuera de la clínica)"], ...colleagues.map((m) => [m.userId, m.user.name])])}
              value={colleagueId}
              onValueChange={(v) => setColleagueId(v ?? "")}
            >
              <SelectTrigger id={`${ids}-colleague`}>
                <SelectValue placeholder="Otro profesional (fuera de la clínica)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">Otro profesional (fuera de la clínica)</SelectItem>
                {colleagues.map((m) => (
                  <SelectItem key={m.userId} value={m.userId}>
                    {m.user.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Un colega de la clínica recibe la tarea con la persona a la vista.</p>
          </Field>
        ) : null}
        {!(kind === "interconsulta" && colleagueId) ? (
          <Field>
            <FieldLabel htmlFor={`${ids}-recipient`}>Para</FieldLabel>
            <Input
              id={`${ids}-recipient`}
              value={recipient}
              onChange={(event) => setRecipient(event.target.value)}
              maxLength={200}
              placeholder={
                kind === "imagen"
                  ? "p. ej. Centro de imágenes"
                  : kind === "laboratorio"
                    ? "p. ej. Laboratorio Central"
                    : "p. ej. Dra. Pérez, cirujana maxilofacial"
              }
            />
          </Field>
        ) : null}
        <DiagnosisSearch
          value={diagnosisCode}
          system={diagnosisSystem}
          onChange={(code, _description, system) => {
            setDiagnosisCode(code)
            setDiagnosisSystem(system)
          }}
          label="Diagnóstico que la motiva"
        />
        {kind === "interconsulta" ? (
          <Field>
            <FieldLabel htmlFor={`${ids}-specialty`}>Especialidad</FieldLabel>
            <Select
              items={Object.fromEntries([
                ["", "Sin especialidad"],
                ...(specialtiesQuery.data?.data ?? []).map((s) => [s.id, s.name]),
              ])}
              value={specialtyId}
              onValueChange={(v) => setSpecialtyId(v ?? "")}
            >
              <SelectTrigger id={`${ids}-specialty`}>
                <SelectValue placeholder="Sin especialidad" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">Sin especialidad</SelectItem>
                {(specialtiesQuery.data?.data ?? []).map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}
        <Field>
          <FieldLabel htmlFor={`${ids}-detail`}>Detalle (opcional)</FieldLabel>
          <Textarea
            id={`${ids}-detail`}
            value={detail}
            onChange={(event) => setDetail(event.target.value)}
            rows={3}
            maxLength={5000}
          />
        </Field>
      </div>
    </FormDrawer>
  )
}
