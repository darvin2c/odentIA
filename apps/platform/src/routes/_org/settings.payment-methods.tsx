import { Badge, Button, FieldError, Input, toast } from "@odentia/ui"
import {
  common,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  SubmitButton,
} from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import { ApiError } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { ChoiceSelect } from "../../components/ui/choice-select"
import {
  createPaymentMethodApi,
  isCashMethod,
  paymentTypeLabel,
  updatePaymentMethodApi,
  usePaymentMethods,
  type PaymentMethod,
} from "../../lib/payment-methods"

export const Route = createFileRoute("/_org/settings/payment-methods")({
  component: PaymentMethodsPage,
})

const TYPE_OPTIONS = ["10", "48", "30", "68", "20", "1"] as const

/**
 * Medios de pago de la clínica: nombre, tipo, activo y orden. Caja ofrece solo
 * los activos y el agente responde con esta misma lista. Apagar un medio no
 * altera los cobros anteriores: el ticket conserva su snapshot.
 */
function PaymentMethodsPage() {
  const canWrite = usePermission("settings.write")
  const queryClient = useQueryClient()
  const methodsQuery = usePaymentMethods(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState({ name: "", typeCode: "1", sortOrder: "0" })
  const [adding, setAdding] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["payment-methods"] })
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const name = draft.name.trim()
      if (!name) throw new Error("Escribe el nombre, como lo dirá caja")
      const sortOrder = Number(draft.sortOrder)
      if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 9999) {
        throw new Error("El orden debe ser un entero entre 0 y 9999")
      }
      if (editingId) {
        return updatePaymentMethodApi(editingId, {
          name,
          typeCode: draft.typeCode as (typeof TYPE_OPTIONS)[number],
          sortOrder,
        })
      }
      return createPaymentMethodApi({
        name,
        typeCode: draft.typeCode as (typeof TYPE_OPTIONS)[number],
        sortOrder,
      })
    },
    onSuccess: () => {
      setEditingId(null)
      setAdding(false)
      setDraft({ name: "", typeCode: "1", sortOrder: "0" })
      setFormError(null)
      refresh()
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : "No se pudo guardar")
    },
  })

  const toggleMutation = useMutation({
    mutationFn: (row: PaymentMethod) =>
      updatePaymentMethodApi(row.id, { isActive: !row.isActive }),
    onSuccess: refresh,
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "No se pudo actualizar")
    },
  })

  if (methodsQuery.isPending) return <LoadingState />
  if (methodsQuery.isError) {
    const err = methodsQuery.error
    return (
      <ErrorState
        message={err instanceof ApiError ? err.message : "No se pudieron cargar los medios de pago"}
        onRetry={() => void methodsQuery.refetch()}
      />
    )
  }

  const methods = [...methodsQuery.data.data].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  )
  const showForm = adding || editingId !== null

  const startEdit = (row: PaymentMethod) => {
    setEditingId(row.id)
    setAdding(false)
    setDraft({ name: row.name, typeCode: row.typeCode, sortOrder: String(row.sortOrder) })
    setFormError(null)
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Medios de pago"
        subtitle="Caja ofrece solo los activos, y el agente responde con esta misma lista. La lista inicial depende del país de la clínica."
        actions={
          canWrite && !showForm ? (
            <Button
              type="button"
              onClick={() => {
                setAdding(true)
                setEditingId(null)
                setDraft({ name: "", typeCode: "1", sortOrder: "0" })
                setFormError(null)
              }}
            >
              Agregar medio
            </Button>
          ) : undefined
        }
      />
      {methods.length === 0 ? (
        <EmptyState
          title="Sin medios de pago"
          description="Agrega al menos uno para poder cobrar."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {methods.map((row) => (
            <li
              key={row.id}
              className="elevated flex flex-col gap-2 rounded-xl border bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{row.name}</span>
                  {!row.isActive ? <Badge variant="secondary">Apagado</Badge> : null}
                </div>
                <p className="text-sm text-muted-foreground">
                  {paymentTypeLabel(row.typeCode)}
                  {isCashMethod(row.typeCode) ? " · se cuenta al cerrar caja" : " · pide número de operación"}
                  {!row.isActive ? " · no se ofrece al cobrar. Los cobros anteriores se conservan." : ""}
                </p>
              </div>
              {canWrite ? (
                <div className="flex gap-2">
                  <Button type="button" variant="ghost" onClick={() => startEdit(row)}>
                    Editar
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={toggleMutation.isPending}
                    onClick={() => toggleMutation.mutate(row)}
                  >
                    {row.isActive ? "Apagar" : "Encender"}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {showForm && canWrite ? (
        <form
          className="elevated flex max-w-xl flex-col gap-4 rounded-xl border bg-card p-6"
          onSubmit={(event) => {
            event.preventDefault()
            saveMutation.mutate()
          }}
        >
          <h2 className="font-heading text-base font-medium">
            {editingId ? "Editar medio" : "Agregar medio"}
          </h2>
          <label className="flex flex-col gap-1 text-sm">
            Nombre, como lo dirá caja
            <Input
              value={draft.name}
              maxLength={120}
              onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Tipo
            <ChoiceSelect
              className="rounded-md border bg-background px-3 py-2"
              value={draft.typeCode}
              onChange={(event) => setDraft((prev) => ({ ...prev, typeCode: event.target.value }))}
            >
              {TYPE_OPTIONS.map((code) => (
                <option key={code} value={code}>
                  {paymentTypeLabel(code)}
                </option>
              ))}
            </ChoiceSelect>
          </label>
          <p className="text-sm text-muted-foreground">
            El tipo decide dos cosas: solo el efectivo se cuenta al cerrar caja, y los
            demás piden número de operación.
          </p>
          <label className="flex flex-col gap-1 text-sm">
            Orden
            <Input
              value={draft.sortOrder}
              inputMode="numeric"
              onChange={(event) => setDraft((prev) => ({ ...prev, sortOrder: event.target.value }))}
            />
          </label>
          {formError ? <FieldError>{formError}</FieldError> : null}
          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setAdding(false)
                setEditingId(null)
                setFormError(null)
              }}
            >
              {common.actions.cancel}
            </Button>
            <SubmitButton type="submit" pending={saveMutation.isPending}>
              {common.actions.save}
            </SubmitButton>
          </div>
        </form>
      ) : null}
    </div>
  )
}
