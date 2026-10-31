/**
 * Almacenes de una sede (ADR 0067), dentro de su formulario en Configuración ›
 * Sedes. Cada sede nace con su «Almacén principal»: de ahí salen las atenciones
 * y las ventas y ahí llegan las compras. Otro almacén solo si hace falta (un
 * gabinete en el consultorio). Cada cambio se guarda al momento y lo confirma el
 * aviso flotante; el principal no se desactiva.
 */
import { Badge, Button, Skeleton, toast } from "@odentia/ui"
import {
  ConfirmDialog,
  RowActions,
  submitErrorMessage,
  submitForm,
  useAppForm,
  useFormSubmitError,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { useId, useRef, useState } from "react"
import { z } from "zod"
import { apiFetch } from "../../lib/api"

interface BranchWarehouse {
  id: string
  branchId: string
  name: string
  isDefault: boolean
  isActive: boolean
}

/** Los mismos topes que `warehouseInput` de la API. */
const warehouseNameSchema = z.object({
  name: z.string().trim().min(1, "Escribe el nombre del almacén").max(200, "Escribe como mucho 200 caracteres"),
})

export function BranchWarehouses({ branchId, branchName }: { branchId: string; branchName: string }) {
  const queryClient = useQueryClient()
  const fieldId = useId()
  const key = ["inventory", "warehouses", "sede", branchId]
  const query = useQuery({
    queryKey: key,
    queryFn: () => apiFetch<{ data: BranchWarehouse[] }>(`/api/inventory/warehouses?branchId=${encodeURIComponent(branchId)}`),
  })
  /** El almacén que se está nombrando o renombrando: `id: null` = uno nuevo. */
  const [naming, setNaming] = useState<{ id: string | null; name: string } | null>(null)
  const [deactivating, setDeactivating] = useState<BranchWarehouse | null>(null)

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["inventory"] })

  const activation = useMutation({
    retry: false,
    mutationFn: (input: { warehouse: BranchWarehouse; isActive: boolean }) =>
      apiFetch(`/api/inventory/warehouses/${input.warehouse.id}/activation`, {
        method: "POST",
        body: JSON.stringify({ isActive: input.isActive }),
      }),
    onSuccess: (_, input) => {
      toast.success(input.isActive ? `${input.warehouse.name} está activo` : `${input.warehouse.name} quedó desactivado`)
      setDeactivating(null)
      refresh()
    },
    // Reactivar es una acción de la fila; el rechazo de desactivar lo dice su diálogo.
    onError: (error, input) => {
      if (input.isActive) toast.error(submitErrorMessage(error))
    },
  })
  const deactivationError =
    activation.isError && activation.variables?.isActive === false ? submitErrorMessage(activation.error) : null

  const rows = query.data?.data ?? []
  return (
    <section aria-labelledby={`${fieldId}-titulo`} className="flex flex-col gap-3 border-t pt-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={`${fieldId}-titulo`} className="text-sm font-semibold">
            Almacenes
          </h3>
          <p className="text-sm text-muted-foreground">Donde se guardan los materiales de esta sede.</p>
        </div>
        {naming === null ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="min-h-11 sm:min-h-8"
            onClick={() => setNaming({ id: null, name: "" })}
          >
            <Plus aria-hidden />
            Almacén
          </Button>
        ) : null}
      </div>

      {query.isPending ? (
        <div role="status" aria-busy="true" aria-label="Cargando los almacenes" className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
        </div>
      ) : query.isError ? (
        <p className="text-sm text-muted-foreground">
          No pudimos cargar los almacenes.{" "}
          <Button type="button" variant="link" className="h-auto p-0" onClick={() => void query.refetch()}>
            Reintentar
          </Button>
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border">
          {rows.map((item) => (
            <li key={item.id} className="flex items-center gap-2 px-3 py-2.5 text-sm">
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5 font-medium">
                  {item.name}
                  {item.isDefault ? <Badge variant="secondary">Principal</Badge> : null}
                  {item.isActive ? null : <Badge variant="outline">Desactivado</Badge>}
                </span>
                {item.isDefault ? (
                  <span className="block text-xs text-muted-foreground">
                    Ahí llegan las compras y de ahí se descuentan las atenciones y las ventas.
                  </span>
                ) : null}
              </span>
              <RowActions
                label={`Acciones de ${item.name}`}
                items={[
                  {
                    key: "renombrar",
                    label: "Renombrar",
                    onSelect: () => setNaming({ id: item.id, name: item.name }),
                  },
                  ...(item.isDefault
                    ? []
                    : [
                        item.isActive
                          ? { key: "desactivar", label: "Desactivar", tone: "danger" as const, onSelect: () => setDeactivating(item) }
                          : {
                              key: "reactivar",
                              label: "Reactivar",
                              disabled: activation.isPending,
                              onSelect: () => activation.mutate({ warehouse: item, isActive: true }),
                            },
                      ]),
                ]}
              />
            </li>
          ))}
        </ul>
      )}

      {naming !== null ? (
        <WarehouseNameForm
          // Cada almacén (o uno nuevo) empieza con su nombre y sin errores de otro.
          key={naming.id ?? "nuevo"}
          id={`${fieldId}-nombre`}
          branchId={branchId}
          branchName={branchName}
          target={naming}
          onClose={() => setNaming(null)}
          onSaved={() => {
            setNaming(null)
            refresh()
          }}
        />
      ) : null}

      <ConfirmDialog
        open={deactivating !== null}
        onClose={() => {
          activation.reset()
          setDeactivating(null)
        }}
        onConfirm={() => deactivating && activation.mutate({ warehouse: deactivating, isActive: false })}
        title={`Desactivar ${deactivating?.name ?? ""}`}
        description="No se podrá elegir para compras ni traslados. Lo que tiene sigue contando en la sede hasta que se use o se traslade, y puedes reactivarlo cuando quieras."
        confirmLabel="Desactivar"
        variant="destructive"
        pending={activation.isPending}
        error={deactivationError}
      />
    </section>
  )
}

/**
 * Nombrar o renombrar un almacén. Va dentro del `<form>` de la sede: no lleva
 * `<form>` propio (no se anidan), se envía con su botón o con Enter. Lo que el
 * servidor dice del nombre va en el campo; lo demás, junto a los botones.
 */
function WarehouseNameForm({
  id,
  branchId,
  branchName,
  target,
  onClose,
  onSaved,
}: {
  id: string
  branchId: string
  branchName: string
  target: { id: string | null; name: string }
  onClose: () => void
  onSaved: () => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const save = useMutation({
    retry: false,
    mutationFn: (name: string) =>
      target.id
        ? apiFetch(`/api/inventory/warehouses/${target.id}`, { method: "PATCH", body: JSON.stringify({ name }) })
        : apiFetch("/api/inventory/warehouses", { method: "POST", body: JSON.stringify({ branchId, name }) }),
  })
  const form = useAppForm({
    defaultValues: { name: target.name },
    validators: { onSubmit: warehouseNameSchema },
    onSubmit: async ({ value }) => {
      await save.mutateAsync(value.name.trim())
      toast.success(target.id ? "Almacén renombrado" : `Almacén agregado a ${branchName}`)
      onSaved()
    },
  })
  const error = useFormSubmitError(form)
  const pending = useStore(form.store, (state) => state.isSubmitting)
  const submit = () => void submitForm(form, { root: root.current })

  return (
    <div ref={root} className="flex flex-col gap-2 rounded-xl border bg-muted/40 p-3">
      <form.AppField name="name">
        {(field) => (
          <field.TextField
            id={id}
            label={target.id ? "Nuevo nombre" : "Nombre del almacén"}
            description={target.id ? undefined : "Solo si hace falta: sin elegir otro, todo usa el principal."}
            autoFocus
            maxLength={200}
            placeholder="Gabinete del consultorio 2"
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                submit()
              }
            }}
          />
        )}
      </form.AppField>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={pending} onClick={submit}>
          {target.id ? "Renombrar" : "Agregar"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onClose}>
          Cancelar
        </Button>
      </div>
    </div>
  )
}
