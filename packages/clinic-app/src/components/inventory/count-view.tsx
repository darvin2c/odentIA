/**
 * Contar lo que hay (tableros 5 y 15, `?contar=si`): la lista se vuelve
 * editable y se escribe lo que hay; odentIA calcula la diferencia. Enter pasa
 * al siguiente, lo escrito se guarda en este navegador hasta «Guardar el
 * conteo» (se puede contar por partes) y lo que no se cuenta no cambia.
 */
import { unitFor } from "@odentia/clinical"
import { Button, Checkbox, Field, FieldLabel, toast } from "@odentia/ui"
import { ConfirmDialog, DataTable, DataTableSkeleton, EmptyState, PageHeader, SearchInput, SubmitButton, ViewTabs, normalizeSearchText, useListSearch } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { ClipboardList, LogOut } from "lucide-react"
import * as React from "react"
import {
  countStock,
  fetchProducts,
  formatWhole,
  inventoryErrorMessage,
  inventoryKeys,
  newKey,
  type ProductListItem,
  parseWhole,
  stockText,
} from "../../lib/inventory"
import { usePageDraftGuard } from "../../lib/page-draft-guard"
import { QueryErrorState } from "../../lib/query-error"
import { QuantityInput } from "./fields"
import { useInventory } from "./inventory-scope"
import { appWords } from "../../lib/product-words"

type CountFilter = "sin_contar" | "diferencia" | "todos"

function readDraft(key: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(key)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    }
  } catch {
    // Sin almacenamiento (modo privado) se cuenta igual: solo no se recuerda.
  }
  return {}
}

/** Guarda lo escrito; `false` si el navegador no deja (entonces se avisa al salir). */
function writeDraft(key: string, draft: Record<string, string>): boolean {
  try {
    const filled = Object.fromEntries(Object.entries(draft).filter(([, value]) => value.trim() !== ""))
    if (Object.keys(filled).length === 0) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(filled))
    return true
  } catch {
    return false
  }
}

function countedOf(text: string | undefined): number | null {
  if (text === undefined) return null
  const parsed = parseWhole(text)
  return parsed === null || Number.isNaN(parsed) ? null : parsed
}

export function CountView({ subtitle, onExit }: { subtitle: React.ReactNode; onExit: () => void }) {
  const { branchId, branchName } = useInventory()
  const queryClient = useQueryClient()
  const { get } = useListSearch()
  const q = normalizeSearchText((get("q") ?? "").trim())
  const storageKey = `odentia:inventario:conteo:${branchId}`
  const products = useQuery({ queryKey: inventoryKeys.products(branchId, "", ""), queryFn: () => fetchProducts(branchId) })
  const items = products.data?.items ?? []
  const [draft, setDraft] = React.useState<Record<string, string>>(() => readDraft(storageKey))
  const [persisted, setPersisted] = React.useState(true)
  React.useEffect(() => setPersisted(writeDraft(storageKey, draft)), [storageKey, draft])
  const written = Object.entries(draft).filter(([id, value]) => value.trim() !== "" && items.some((item) => item.id === id))
  const counted = written.filter(([, value]) => countedOf(value) !== null)
  const differing = counted.filter(([id, value]) => countedOf(value) !== items.find((item) => item.id === id)?.onHand)
  const guard = usePageDraftGuard(!persisted && written.length > 0)

  // El filtro se fija al elegirlo: lo que se cuenta no desaparece mientras se escribe.
  const [filter, setFilter] = React.useState<CountFilter>("sin_contar")
  const [shown, setShown] = React.useState<Set<string> | null>(null)
  const pick = React.useCallback(
    (next: CountFilter) => {
      setFilter(next)
      setShown(
        next === "todos"
          ? null
          : new Set(
              items
                .filter((item) => {
                  const value = countedOf(draft[item.id])
                  return next === "sin_contar" ? value === null : value !== null && value !== item.onHand
                })
                .map((item) => item.id),
            ),
      )
    },
    [items, draft],
  )
  const ready = products.isSuccess
  const pickedOnLoad = React.useRef(false)
  React.useEffect(() => {
    if (!ready || pickedOnLoad.current) return
    pickedOnLoad.current = true
    pick("sin_contar")
  }, [ready, pick])
  const rows = items.filter(
    (item) => (shown === null || shown.has(item.id)) && (!q || normalizeSearchText(`${item.name} ${item.sku}`).includes(q)),
  )

  const [key, setKey] = React.useState(newKey)
  const save = useMutation({
    mutationFn: () =>
      countStock(
        branchId,
        counted.map(([productId, value]) => ({ productId, counted: countedOf(value) as number })),
        key,
      ),
    onSuccess: (result) => {
      setKey(newKey())
      setDraft({})
      writeDraft(storageKey, {})
      const changed = result.changed.length
      toast.success(
        changed === 0
          ? "Conteo guardado: todo estaba igual."
          : `Conteo guardado: ${changed === 1 ? "1 producto cambió" : `${formatWhole(changed)} productos cambiaron`} con el motivo «Conteo».`,
      )
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
      onExit()
    },
  })

  const container = React.useRef<HTMLFormElement>(null)
  const next = React.useCallback((from: HTMLInputElement) => {
    const inputs = [...(container.current?.querySelectorAll<HTMLInputElement>("[data-count-input]") ?? [])]
    const at = inputs.indexOf(from)
    const target = inputs[at + 1]
    if (target) {
      target.focus()
      target.select()
    } else container.current?.querySelector<HTMLButtonElement>("button[type=submit]")?.focus()
  }, [])

  const columns = React.useMemo<ColumnDef<ProductListItem>[]>(
    () => [
      { id: "producto", header: "Producto", meta: { view: { role: "title" } }, cell: ({ row }) => <span className="font-medium">{row.original.name}</span> },
      {
        id: "tiene",
        header: () => <span className="block text-right">{appWords().name} tiene</span>,
        meta: { view: { primary: true, label: `${appWords().name} tiene` } },
        cell: ({ row }) => (
          <span className="block whitespace-nowrap tabular-nums md:text-right">
            <span className="md:hidden">{appWords().name} tiene </span>
            {stockText(row.original.onHand, row.original)}
          </span>
        ),
      },
      {
        id: "contaste",
        header: () => <span className="block text-right">Contaste</span>,
        meta: { view: { primary: true, label: "Contaste" } },
        cell: ({ row }) => (
          <QuantityInput
            className="ml-auto w-32"
            data-count-input={row.original.id}
            aria-label={`Contaste de ${row.original.name}, en ${unitFor(2, row.original.unit)}`}
            placeholder="—"
            // Se cuenta en la unidad de uso, aunque se compre por cajas: así lo dice el campo.
            suffix={unitFor(countedOf(draft[row.original.id]) === 1 ? 1 : 2, row.original.unit)}
            value={draft[row.original.id] ?? ""}
            invalid={(draft[row.original.id] ?? "").trim() !== "" && countedOf(draft[row.original.id]) === null}
            onChange={(value) => setDraft((current) => ({ ...current, [row.original.id]: value }))}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return
              event.preventDefault()
              next(event.currentTarget)
            }}
          />
        ),
      },
      {
        id: "diferencia",
        header: () => <span className="block text-right">Diferencia</span>,
        meta: { view: { primary: true, label: "Diferencia" } },
        cell: ({ row }) => {
          const value = countedOf(draft[row.original.id])
          if (value === null) return <span className="block text-muted-foreground md:text-right">sin contar</span>
          const delta = value - row.original.onHand
          if (delta === 0) return <span className="block text-muted-foreground md:text-right">igual</span>
          return (
            <span className={`block font-semibold tabular-nums md:text-right ${delta < 0 ? "text-destructive" : "text-success"}`}>
              {delta > 0 ? "+" : ""}
              {formatWhole(delta)}
            </span>
          )
        },
      },
    ],
    [draft, next],
  )
  // Sin paginación: reiniciar la página con cada lista nueva re-renderiza sin fin (las filas son otro arreglo en cada render).
  const table = useReactTable({ data: rows, columns, autoResetPageIndex: false, getCoreRowModel: getCoreRowModel(), getRowId: (row) => row.id })

  const [invalidNotice, setInvalidNotice] = React.useState(false)
  const [leaving, setLeaving] = React.useState(false)
  const [discard, setDiscard] = React.useState(false)
  const filters: Array<{ value: CountFilter; label: string; count: number }> = [
    { value: "sin_contar", label: "Sin contar", count: items.length - counted.length },
    { value: "diferencia", label: "Con diferencia", count: differing.length },
    { value: "todos", label: "Todos", count: items.length },
  ]

  return (
    <>
      {guard.dialog}
      <PageHeader
        title="Contar lo que hay"
        subtitle={subtitle}
        primary={{
          label: "Salir sin guardar",
          icon: <LogOut aria-hidden />,
          onClick: () => {
            if (written.length === 0) onExit()
            else {
              setDiscard(false)
              setLeaving(true)
            }
          },
        }}
      />
      <form
        ref={container}
        className="flex flex-col gap-3"
        onKeyDown={(event) => {
          // Enter en el buscador no guarda el conteo: solo los campos de «Contaste» pasan al siguiente.
          if (event.key === "Enter" && event.target instanceof HTMLInputElement && !event.target.dataset.countInput) event.preventDefault()
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (save.isPending || counted.length === 0) return
          // Lo escrito que no es un número no se descarta en silencio: se corrige antes de guardar.
          const wrong = written.find(([, value]) => countedOf(value) === null)
          if (wrong) {
            setInvalidNotice(true)
            const input = container.current?.querySelector<HTMLInputElement>(`[data-count-input="${wrong[0]}"]`)
            if (input) {
              input.focus()
              input.select()
            } else pick("todos")
            return
          }
          setInvalidNotice(false)
          save.mutate()
        }}
      >
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-card p-3">
          <SearchInput label="Buscar en productos" placeholder="Buscar por nombre o código" expandable />
          <ViewTabs label="Qué productos ver" value={filter} options={filters} onValueChange={pick} />
        </div>

        {products.isPending ? (
          <DataTableSkeleton columnCount={4} label="Cargando productos…" />
        ) : products.isError && items.length === 0 ? (
          <QueryErrorState error={products.error} onRetry={() => void products.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState icon={ClipboardList} title={`No hay productos en ${branchName}`} description="Cuando haya productos, aquí se cuenta lo que hay de cada uno." actionLabel="Volver" onAction={onExit} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title={filter === "sin_contar" ? "Ya contaste todo lo de esta vista" : "Nada que mostrar aquí"}
            description="Elige «Todos» para revisar lo contado antes de guardar."
            actionLabel="Ver todos"
            onAction={() => pick("todos")}
          />
        ) : (
          <DataTable table={table} isFetching={products.isFetching} />
        )}

        {invalidNotice && written.length !== counted.length ? (
          <p role="alert" className="text-sm text-destructive">
            Corrige lo que está en rojo: cada producto se cuenta con un número entero.
          </p>
        ) : null}
        {save.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {inventoryErrorMessage(save.error)}
          </p>
        ) : null}
        {!persisted && written.length > 0 ? (
          <p className="text-sm text-warning">Este navegador no deja guardar lo escrito: guarda el conteo antes de salir.</p>
        ) : null}

        <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t bg-canvas/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:mx-0 sm:rounded-md sm:border sm:bg-card sm:px-4">
          <p className="text-sm" role="status">
            {formatWhole(counted.length)} {counted.length === 1 ? "contado" : "contados"} · {formatWhole(differing.length)} con diferencia. Lo que no cuentes no cambia.
          </p>
          <SubmitButton type="submit" pending={save.isPending} disabled={counted.length === 0} className="min-h-11 sm:min-h-9">
            Guardar el conteo
          </SubmitButton>
        </div>
      </form>

      <ConfirmDialog
        open={leaving}
        variant={discard ? "destructive" : "default"}
        title="¿Salir sin guardar el conteo?"
        description="El inventario no cambia. Lo que escribiste queda en este navegador para seguir después."
        confirmLabel={discard ? "Borrar y salir" : "Salir"}
        cancelLabel="Seguir contando"
        onClose={() => setLeaving(false)}
        onConfirm={() => {
          if (discard) {
            setDraft({})
            writeDraft(storageKey, {})
          }
          setLeaving(false)
          onExit()
        }}
      >
        <Field orientation="horizontal">
          <Checkbox id="conteo-borrar" checked={discard} onCheckedChange={(checked) => setDiscard(checked === true)} />
          <FieldLabel htmlFor="conteo-borrar" className="font-normal">
            Borrar lo que escribí
          </FieldLabel>
        </Field>
      </ConfirmDialog>
    </>
  )
}
