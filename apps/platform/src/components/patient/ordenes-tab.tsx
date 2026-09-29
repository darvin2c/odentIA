import {
  Badge,
  Button,
  Field,
  FieldError,
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
import { EmptyState, ErrorState, FormDrawer, PageHeader } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useRef, useState } from "react"
import { ApiError } from "../../lib/api"
import {
  advanceOrder,
  createOrder,
  fetchOrders,
  fetchSpecialties,
  ORDER_STATUS_LABELS,
  type ClinicalOrder,
} from "../../lib/clinical-forms"
import { usePermission } from "../../lib/crm"

/**
 * Órdenes de laboratorio e interconsulta: destinatario libre, especialidad
 * destino de la organización (sin listas fijas) y resultado al completar.
 */
export function OrdenesTab({
  patientId,
  encounterId,
}: {
  patientId: string
  encounterId?: string
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const canRead = usePermission("clinical.read")
  const canWrite = usePermission("clinical.write")
  const [kindFilter, setKindFilter] = useState("")
  const [drawerOpen, setDrawerOpen] = useState(false)
  const submitRef = useRef<() => void>(() => {})

  const listQuery = useQuery({
    queryKey: ["clinical-orders", patientId, kindFilter],
    queryFn: () =>
      fetchOrders({ patientId, ...(kindFilter ? { kind: kindFilter } : {}) }),
    enabled: canRead,
  })
  const orders = listQuery.data?.data ?? []
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["clinical-orders", patientId] })
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Órdenes clínicas"
        subtitle="Laboratorio e interconsultas con seguimiento de estado y resultado."
        actions={
          canWrite ? (
            <Button type="button" onClick={() => setDrawerOpen(true)}>
              Nueva orden
            </Button>
          ) : undefined
        }
      />
      <div className="flex flex-wrap gap-2">
        <Select value={kindFilter || "todas"} onValueChange={(v: string | null) => setKindFilter(v === "todas" ? "" : (v ?? ""))}>
          <SelectTrigger className="w-56" aria-label="Filtrar por tipo">
            <SelectValue placeholder="Todas" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="todas">Todas</SelectItem>
            <SelectItem value="laboratorio">Laboratorio</SelectItem>
            <SelectItem value="interconsulta">Interconsulta</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {listQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : listQuery.isError ? (
        <ErrorState message="No se pudieron cargar las órdenes" onRetry={() => void listQuery.refetch()} />
      ) : orders.length === 0 ? (
        <EmptyState
          title="Sin órdenes"
          description="Crea una orden de laboratorio o una interconsulta hacia la especialidad y el destinatario que corresponda."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {orders.map((order) => (
            <OrderCard key={order.id} order={order} canWrite={canWrite} onChanged={invalidate} />
          ))}
        </ul>
      )}
      <FormDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Nueva orden"
        onSubmit={() => submitRef.current()}
        submitLabel="Crear orden"
      >
        <NewOrderForm
          patientId={patientId}
          encounterId={encounterId}
          registerSubmit={(fn) => {
            submitRef.current = fn
          }}
          onDone={() => {
            setDrawerOpen(false)
            invalidate()
          }}
        />
      </FormDrawer>
    </div>
  )
}

function statusVariant(status: ClinicalOrder["status"]): "default" | "secondary" | "success" | "destructive" {
  if (status === "completado") return "success"
  if (status === "cancelado") return "destructive"
  if (status === "en_proceso") return "default"
  return "secondary"
}

function OrderCard({
  order,
  canWrite,
  onChanged,
}: {
  order: ClinicalOrder
  canWrite: boolean
  onChanged: () => void
}) {
  const [result, setResult] = useState(order.resultText ?? "")
  const [showResult, setShowResult] = useState(false)
  const mutation = useMutation({
    mutationFn: (body: { toStatus: "en_proceso" | "completado" | "cancelado"; resultText?: string | null }) =>
      advanceOrder(order.id, body),
    onSuccess: () => {
      setShowResult(false)
      onChanged()
      toast.success("Orden actualizada")
    },
    onError: (e: unknown) => {
      toast.error(e instanceof ApiError ? (e.shape.message ?? "Falló la operación") : "Falló la operación")
    },
  })

  const next: ReadonlyArray<"en_proceso" | "completado" | "cancelado"> = useMemo(() => {
    if (order.status === "solicitado") return ["en_proceso", "cancelado"]
    if (order.status === "en_proceso") return ["completado", "cancelado"]
    return []
  }, [order.status])

  return (
    <li className="rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">
            {order.kind === "laboratorio" ? "Laboratorio" : "Interconsulta"} · {order.title}
          </p>
          <p className="text-sm text-muted-foreground">
            Para: {order.recipient}
            {order.detail ? ` · ${order.detail}` : ""}
          </p>
        </div>
        <Badge variant={statusVariant(order.status)}>{ORDER_STATUS_LABELS[order.status]}</Badge>
      </div>
      {order.status === "completado" && order.resultText ? (
        <p className="mt-2 rounded-md bg-muted/40 p-2 text-sm">
          <strong>Resultado:</strong> {order.resultText}
        </p>
      ) : null}
      {canWrite && next.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {next.includes("en_proceso") ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate({ toStatus: "en_proceso" })}
            >
              Pasar a en proceso
            </Button>
          ) : null}
          {next.includes("completado") && !showResult ? (
            <Button type="button" size="sm" onClick={() => setShowResult(true)}>
              Completar con resultado
            </Button>
          ) : null}
          {next.includes("cancelado") ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate({ toStatus: "cancelado" })}
            >
              Cancelar
            </Button>
          ) : null}
        </div>
      ) : null}
      {showResult ? (
        <div className="mt-2 flex flex-col gap-2">
          <Textarea
            value={result}
            onChange={(event) => setResult(event.target.value)}
            rows={3}
            maxLength={10000}
            placeholder="Resultado de laboratorio o respuesta de interconsulta"
            aria-label="Resultado de la orden"
          />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!result.trim() || mutation.isPending}
              onClick={() => mutation.mutate({ toStatus: "completado", resultText: result.trim() })}
            >
              Guardar resultado
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setShowResult(false)}>
              Volver
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  )
}

function NewOrderForm({
  patientId,
  encounterId,
  registerSubmit,
  onDone,
}: {
  patientId: string
  encounterId?: string
  registerSubmit: (fn: () => void) => void
  onDone: () => void
}) {
  const [kind, setKind] = useState<"laboratorio" | "interconsulta">("laboratorio")
  const [specialtyId, setSpecialtyId] = useState("")
  const [recipient, setRecipient] = useState("")
  const [title, setTitle] = useState("")
  const [detail, setDetail] = useState("")
  const [error, setError] = useState<string | null>(null)

  const specialtiesQuery = useQuery({
    queryKey: ["specialties-active"],
    queryFn: () => fetchSpecialties({ activeOnly: true }),
  })

  const createMutation = useMutation({
    mutationFn: () =>
      createOrder({
        kind,
        specialtyId: specialtyId ? specialtyId : null,
        patientId,
        encounterId: encounterId ?? null,
        recipient: recipient.trim(),
        title: title.trim(),
        detail: detail.trim() ? detail.trim() : null,
      }),
    onSuccess: () => {
      toast.success("Orden creada")
      onDone()
    },
    onError: (e: unknown) => {
      setError(e instanceof ApiError ? (e.shape.message ?? "Falló la operación") : "Falló la operación")
    },
  })

  useEffect(() => {
    registerSubmit(() => {
      if (!recipient.trim() || !title.trim()) {
        setError("Indica el destinatario y el título de la orden")
        return
      }
      setError(null)
      createMutation.mutate()
    })
  })

  return (
    <div className="flex flex-col gap-4">
      <Field>
        <FieldLabel>Tipo</FieldLabel>
        <Select value={kind} onValueChange={(v) => setKind(v as "laboratorio" | "interconsulta")}>
          <SelectTrigger aria-label="Tipo de orden">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="laboratorio">Laboratorio</SelectItem>
            <SelectItem value="interconsulta">Interconsulta</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel>Especialidad destino</FieldLabel>
        <Select value={specialtyId || "ninguna"} onValueChange={(v: string | null) => setSpecialtyId(v === "ninguna" ? "" : (v ?? ""))}>
          <SelectTrigger aria-label="Especialidad destino">
            <SelectValue placeholder="Sin especialidad" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ninguna">Sin especialidad</SelectItem>
            {(specialtiesQuery.data?.data ?? []).map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor="order-recipient">Destinatario (laboratorio o profesional)</FieldLabel>
        <Input
          id="order-recipient"
          value={recipient}
          onChange={(event) => setRecipient(event.target.value)}
          maxLength={200}
          placeholder="p. ej. Laboratorio Central, Dra. Pérez"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="order-title">Título</FieldLabel>
        <Input
          id="order-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={200}
          placeholder="p. ej. Radiografía panorámica"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="order-detail">Detalle</FieldLabel>
        <Textarea
          id="order-detail"
          value={detail}
          onChange={(event) => setDetail(event.target.value)}
          rows={3}
          maxLength={5000}
        />
      </Field>
      {error ? <FieldError>{error}</FieldError> : null}
      {createMutation.isPending ? (
        <p className="text-sm text-muted-foreground">Creando…</p>
      ) : null}
    </div>
  )
}
