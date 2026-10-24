/**
 * Almacenes de una sede (ADR 0067), dentro de su formulario en Configuración ›
 * Sedes. Cada sede nace con su «Almacén principal»: de ahí salen las atenciones
 * y las ventas y ahí llegan las compras. Otro almacén solo si hace falta (un
 * gabinete en el consultorio). Cada cambio se guarda al momento y lo confirma el
 * aviso flotante; el principal no se desactiva.
 */
import { Badge, Button, Field, FieldDescription, FieldError, FieldLabel, Input, Skeleton, toast } from "@odentia/ui"
import { ConfirmDialog, RowActions } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { useId, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"

interface BranchWarehouse {
  id: string
  branchId: string
  name: string
  isDefault: boolean
  isActive: boolean
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.status < 500 && error.shape.message ? error.shape.message : fallback
}

export function BranchWarehouses({ branchId, branchName }: { branchId: string; branchName: string }) {
  const queryClient = useQueryClient()
  const fieldId = useId()
  const key = ["inventory", "warehouses", "sede", branchId]
  const query = useQuery({
    queryKey: key,
    queryFn: () => apiFetch<{ data: BranchWarehouse[] }>(`/api/inventory/warehouses?branchId=${encodeURIComponent(branchId)}`),
  })
  /** El almacén que se está nombrando o renombrando: `null` = uno nuevo. */
  const [naming, setNaming] = useState<{ id: string | null; name: string } | null>(null)
  const [nameError, setNameError] = useState<string | null>(null)
  const [deactivating, setDeactivating] = useState<BranchWarehouse | null>(null)

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["inventory"] })

  const save = useMutation({
    retry: false,
    mutationFn: (input: { id: string | null; name: string }) =>
      input.id
        ? apiFetch(`/api/inventory/warehouses/${input.id}`, { method: "PATCH", body: JSON.stringify({ name: input.name }) })
        : apiFetch("/api/inventory/warehouses", { method: "POST", body: JSON.stringify({ branchId, name: input.name }) }),
    onSuccess: (_, input) => {
      toast.success(input.id ? "Almacén renombrado" : `Almacén agregado a ${branchName}`)
      setNaming(null)
      refresh()
    },
    onError: (error) => setNameError(messageOf(error, "No se guardó el almacén. Inténtalo de nuevo.")),
  })

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
    onError: (error) => toast.error(messageOf(error, "No se guardó el cambio. Inténtalo de nuevo.")),
  })

  const submitName = () => {
    if (!naming) return
    const name = naming.name.trim()
    if (!name) {
      setNameError("Escribe el nombre del almacén")
      return
    }
    setNameError(null)
    save.mutate({ id: naming.id, name })
  }

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
            onClick={() => {
              setNameError(null)
              setNaming({ id: null, name: "" })
            }}
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
                    onSelect: () => {
                      setNameError(null)
                      setNaming({ id: item.id, name: item.name })
                    },
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
        <div className="flex flex-col gap-2 rounded-xl border bg-muted/40 p-3">
          <Field>
            <FieldLabel htmlFor={`${fieldId}-nombre`}>{naming.id ? "Nuevo nombre" : "Nombre del almacén"}</FieldLabel>
            <Input
              id={`${fieldId}-nombre`}
              autoFocus
              maxLength={200}
              placeholder="Gabinete del consultorio 2"
              aria-invalid={nameError ? true : undefined}
              value={naming.name}
              onChange={(event) => setNaming({ ...naming, name: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  submitName()
                }
              }}
            />
            {naming.id ? null : (
              <FieldDescription>Solo si hace falta: sin elegir otro, todo usa el principal.</FieldDescription>
            )}
            <FieldError>{nameError}</FieldError>
          </Field>
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={save.isPending} onClick={submitName}>
              {naming.id ? "Renombrar" : "Agregar"}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={save.isPending} onClick={() => setNaming(null)}>
              Cancelar
            </Button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={deactivating !== null}
        onClose={() => setDeactivating(null)}
        onConfirm={() => deactivating && activation.mutate({ warehouse: deactivating, isActive: false })}
        title={`Desactivar ${deactivating?.name ?? ""}`}
        description="No se podrá elegir para compras ni traslados. Lo que tiene sigue contando en la sede hasta que se use o se traslade, y puedes reactivarlo cuando quieras."
        confirmLabel="Desactivar"
        variant="destructive"
        pending={activation.isPending}
      />
    </section>
  )
}
