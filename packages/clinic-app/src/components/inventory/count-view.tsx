/**
 * Contar lo que hay (tableros 5 y 15, `?contar=si`): la lista se vuelve
 * editable y se escribe lo que hay; odentIA calcula la diferencia. Enter pasa
 * al siguiente, lo escrito se guarda en este navegador hasta «Guardar el
 * conteo» (se puede contar por partes) y lo que no se cuenta no cambia.
 */
import { unitFor } from "@odentia/clinical"
import { Checkbox, Field, FieldLabel, toast } from "@odentia/ui"
import {
  ConfirmDialog,
  DataTable,
  EmptyState,
  normalizeSearchText,
  PageHeader,
  SearchInput,
  SubmitButton,
  useAppForm,
  useFormSubmit,
  useFormSubmitError,
  useListSearch,
  ViewTabs,
  SkeletonRegion,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { ClipboardList } from "lucide-react"
import * as React from "react"
import { z } from "zod"
import {
  countStock,
  fetchProducts,
  formatWhole,
  inventoryKeys,
  inventoryUnconfirmedMessage,
  newKey,
  type ProductListItem,
  parseWhole,
  stockText,
} from "../../lib/inventory"
import { usePageDraftGuard } from "../../lib/page-draft-guard"
import { appWords } from "../../lib/product-words"
import { QueryErrorState } from "../../lib/query-error"
import { inventoryCountPrimary } from "../../lib/screen-rules"
import { CountRowsSkeleton } from "../skeletons/inventory"
import { QuantityInput } from "./fields"
import { useInventory } from "./inventory-scope"

type CountFilter = "sin_contar" | "diferencia" | "todos"

/** Lo que se escribió de cada producto, por su id. */
type Counts = Record<string, string>

/** El mismo tope que el servidor (`counted`). */
const MAX_COUNT = 1_000_000_000

function readDraft(key: string): Counts {
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
function writeDraft(key: string, draft: Counts): boolean {
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
  return parsed === null || Number.isNaN(parsed) || parsed > MAX_COUNT ? null : parsed
}

export function CountView({ subtitle, onExit }: { subtitle: React.ReactNode; onExit: () => void }) {
  const { branchId, branchName } = useInventory()
  const queryClient = useQueryClient()
  const { get } = useListSearch()
  const q = normalizeSearchText((get("q") ?? "").trim())
  const storageKey = `odentia:inventario:conteo:${branchId}`
  const products = useQuery({ queryKey: inventoryKeys.products(branchId, "", ""), queryFn: () => fetchProducts(branchId) })
  const items = products.data?.items ?? []

  const [key, setKey] = React.useState(newKey)
  // El orden en que viajaron: `items[i]` del servidor es el producto `sent[i]`.
  const sent = React.useRef<string[]>([])
  const save = useMutation({
    mutationFn: (rows: Array<{ productId: string; counted: number }>) => countStock(branchId, rows, key),
  })

  const schema = React.useMemo(() => {
    const known = new Set(items.map((item) => item.id))
    return z.object({ counts: z.record(z.string(), z.string()) }).superRefine((value, ctx) => {
      for (const [id, text] of Object.entries(value.counts)) {
        if (!known.has(id) || text.trim() === "") continue
        // Lo escrito que no es un número no se descarta en silencio: se corrige antes de guardar.
        if (countedOf(text) === null)
          ctx.addIssue({ code: "custom", path: ["counts", id], message: `Escribe un número entero de 0 a ${formatWhole(MAX_COUNT)}.` })
      }
    })
  }, [items])

  // Lo escrito antes se lee una vez, al abrir.
  const [initialDraft] = React.useState(() => readDraft(storageKey))
  const form = useAppForm({
    defaultValues: { counts: initialDraft },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const rows = Object.entries(value.counts)
        .filter(([id, text]) => text.trim() !== "" && items.some((item) => item.id === id))
        .map(([productId, text]) => ({ productId, counted: countedOf(text) as number }))
      // No es de ninguna fila: se dice junto al botón.
      if (rows.length === 0) throw new Error("Escribe lo que hay de al menos un producto.")
      sent.current = rows.map((row) => row.productId)
      const result = await save.mutateAsync(rows)
      setKey(newKey())
      form.reset({ counts: {} })
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
    // Lo que hay que corregir puede estar fuera del filtro: se muestran todos.
    onSubmitInvalid: ({ formApi }) => {
      const wrong = Object.keys(formApi.state.values.counts).find((id) => formApi.getFieldMeta(`counts.${id}`)?.errors.length)
      if (wrong && !container.current?.querySelector(`[data-count-input="${wrong}"]`)) pick("todos")
    },
  })
  const submit = useFormSubmit(form, {
    // Cada fila se dice en su campo «Contaste».
    fieldMap: (serverField) => {
      const index = /^items\[(\d+)\]/.exec(serverField)?.[1]
      const id = index === undefined ? undefined : sent.current[Number(index)]
      return id ? `counts.${id}` : undefined
    },
    formMessage: (error) => inventoryUnconfirmedMessage(error),
  })
  const submitError = useFormSubmitError(form)

  const draft = useStore(form.store, (state) => state.values.counts)
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
          <form.AppField name={`counts.${row.original.id}`}>
            {(field) => (
              <field.Control hideLabel className="ml-auto w-32 gap-1" label={`Contaste de ${row.original.name}, en ${unitFor(2, row.original.unit)}`}>
                {(control) => (
                  <QuantityInput
                    id={control.id}
                    data-count-input={row.original.id}
                    placeholder="—"
                    // Se cuenta en la unidad de uso, aunque se compre por cajas: así lo dice el campo.
                    suffix={unitFor(countedOf(field.state.value) === 1 ? 1 : 2, row.original.unit)}
                    value={field.state.value ?? ""}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onChange={(value) => field.handleChange(value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return
                      event.preventDefault()
                      next(event.currentTarget)
                    }}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
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
    [draft, next, form],
  )
  // Sin paginación: reiniciar la página con cada lista nueva re-renderiza sin fin (las filas son otro arreglo en cada render).
  const table = useReactTable({ data: rows, columns, autoResetPageIndex: false, getCoreRowModel: getCoreRowModel(), getRowId: (row) => row.id })

  const isSubmitting = useStore(form.store, (state) => state.isSubmitting)
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
        primary={inventoryCountPrimary(() => {
          if (written.length === 0) onExit()
          else {
            setDiscard(false)
            setLeaving(true)
          }
        })}
      />
      <form
        ref={container}
        noValidate
        className="flex flex-col gap-3"
        onKeyDown={(event) => {
          // Enter en el buscador no guarda el conteo: solo los campos de «Contaste» pasan al siguiente.
          if (event.key === "Enter" && event.target instanceof HTMLInputElement && !event.target.dataset.countInput) event.preventDefault()
        }}
        onSubmit={(event) => {
          if (isSubmitting) {
            event.preventDefault()
            return
          }
          submit(event)
        }}
      >
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-card p-3">
          <SearchInput label="Buscar en productos" placeholder="Buscar por nombre o código" expandable />
          <ViewTabs label="Qué productos ver" value={filter} options={filters} onValueChange={pick} />
        </div>

        {products.isPending ? (
          <SkeletonRegion message="Cargando productos…">
            <CountRowsSkeleton systemLabel={`${appWords().name} tiene`} />
          </SkeletonRegion>
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

        {!persisted && written.length > 0 ? (
          <p className="text-sm text-warning">Este navegador no deja guardar lo escrito: guarda el conteo antes de salir.</p>
        ) : null}

        <div className="sticky bottom-0 z-10 -mx-4 flex flex-col gap-2 border-t bg-canvas/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:mx-0 sm:rounded-md sm:border sm:bg-card sm:px-4">
          {submitError ? (
            <p role="alert" className="text-sm text-destructive">
              {submitError}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm" role="status">
              {formatWhole(counted.length)} {counted.length === 1 ? "contado" : "contados"} · {formatWhole(differing.length)} con diferencia. Lo que no cuentes no cambia.
            </p>
            <SubmitButton type="submit" pending={isSubmitting} className="min-h-11 sm:min-h-9">
              Guardar el conteo
            </SubmitButton>
          </div>
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
            form.reset({ counts: {} })
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
