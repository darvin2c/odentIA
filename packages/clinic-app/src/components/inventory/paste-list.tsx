/**
 * Pegar tu lista (tablero 4): lo que más frena es cargar el inventario la
 * primera vez. Se pegan las columnas de Excel o Google Sheets, odentIA
 * reconoce Nombre, Unidad, Hay y Mínimo («Cambiar columnas» si no acertó) y el
 * servidor dice qué pasa con cada fila: nueva, ya está, se parece a otra
 * («Es el mismo» / «Es otro») o no sirve (con su motivo). Lo revisado se queda
 * en este navegador aunque se cierre la ventana. Es un cajón ancho: la tabla
 * necesita espacio.
 */
import {
  Button,
  Checkbox,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Textarea,
  toast,
} from "@odentia/ui"
import { DataTable, FormDrawer } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import * as React from "react"
import {
  formatWhole,
  type ImportPreviewRow,
  type ImportRowInput,
  importProducts,
  inventoryErrorMessage,
  inventoryKeys,
  newKey,
  previewImport,
  unitsText,
} from "../../lib/inventory"
import { guessColumns, PASTE_COLUMN_OPTIONS, PASTE_MAX_ROWS, type PasteColumn, recognizedText, sheetRows, splitSheet } from "../../lib/inventory-paste"
import { ChoiceSelect } from "../ui/choice-select"
import { Chip } from "./fields"
import { useInventory } from "./inventory-scope"

type Decision = "mismo" | "otro"

interface PasteDraft {
  text: string
  header: boolean
  columns: PasteColumn[]
  decisions: Record<number, Decision>
}

const EMPTY: PasteDraft = { text: "", header: false, columns: [], decisions: {} }

function readDraft(key: string): PasteDraft {
  try {
    const raw = localStorage.getItem(key)
    const parsed = raw ? (JSON.parse(raw) as Partial<PasteDraft>) : null
    if (parsed && typeof parsed.text === "string") {
      return {
        text: parsed.text,
        header: parsed.header === true,
        columns: Array.isArray(parsed.columns) ? (parsed.columns as PasteColumn[]) : [],
        decisions: parsed.decisions && typeof parsed.decisions === "object" ? (parsed.decisions as Record<number, Decision>) : {},
      }
    }
  } catch {
    // Sin almacenamiento se revisa igual: solo no se recuerda al cerrar.
  }
  return EMPTY
}

function writeDraft(key: string, draft: PasteDraft) {
  try {
    if (!draft.text.trim()) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(draft))
  } catch {
    // Igual que al leer: lo revisado vive mientras la ventana siga abierta.
  }
}

/** Una fila de la tabla: lo pegado tal cual y lo que el servidor dice de ella. */
interface Row {
  index: number
  input: ImportRowInput
  review: ImportPreviewRow | undefined
}

export function PasteListDrawer({ onClose }: { onClose: () => void }) {
  const { branchId, branchName } = useInventory()
  const queryClient = useQueryClient()
  const ids = React.useId()
  const storageKey = `odentia:inventario:lista:${branchId}`
  const [draft, setDraft] = React.useState<PasteDraft>(() => readDraft(storageKey))
  const [changing, setChanging] = React.useState(false)
  const [key, setKey] = React.useState(newKey)
  React.useEffect(() => writeDraft(storageKey, draft), [storageKey, draft])

  const sheet = React.useMemo(() => splitSheet(draft.text), [draft.text])
  const inputs = React.useMemo(() => sheetRows(sheet, draft.header, draft.columns), [sheet, draft.header, draft.columns])
  const mapped = draft.columns.includes("nombre") && draft.columns.includes("hay")
  const tooMany = sheet.length - (draft.header ? 1 : 0) > PASTE_MAX_ROWS

  const setText = (text: string) => {
    const rows = splitSheet(text)
    const guessed = guessColumns(rows)
    setDraft({ text, header: guessed.header, columns: guessed.columns, decisions: {} })
    setChanging(false)
  }

  // La vista previa espera a que se deje de escribir.
  const requestKey = JSON.stringify(inputs)
  const [settled, setSettled] = React.useState(requestKey)
  React.useEffect(() => {
    const timer = window.setTimeout(() => setSettled(requestKey), 400)
    return () => window.clearTimeout(timer)
  }, [requestKey])
  const preview = useQuery({
    queryKey: ["inventory", "import-preview", branchId, settled],
    queryFn: () => previewImport(branchId, JSON.parse(settled) as ImportRowInput[]),
    enabled: mapped && inputs.length > 0 && settled === requestKey,
    placeholderData: (previous) => previous,
    staleTime: 60_000,
  })
  const reviews = preview.data && settled === requestKey ? preview.data.rows : []
  const rows: Row[] = inputs.map((input, index) => ({ index, input, review: reviews[index] }))
  const decide = React.useCallback(
    (index: number, decision: Decision | undefined) =>
      setDraft((current) => {
        const decisions = { ...current.decisions }
        if (decision) decisions[index] = decision
        else delete decisions[index]
        return { ...current, decisions }
      }),
    [],
  )
  const readyOf = (row: Row) =>
    row.review !== undefined && (row.review.status === "nuevo" || row.review.status === "existe" || (row.review.status === "parecido" && draft.decisions[row.index] !== undefined))
  const ready = rows.filter(readyOf)
  const pending = rows.length - ready.length

  const save = useMutation({
    mutationFn: () =>
      importProducts(
        branchId,
        ready.map((row) => ({
          ...row.input,
          productId: row.review?.status === "parecido" && draft.decisions[row.index] === "mismo" ? (row.review.similarTo?.id ?? null) : null,
        })),
        key,
      ),
    onSuccess: (result) => {
      setKey(newKey())
      writeDraft(storageKey, EMPTY)
      const parts = [
        result.created > 0 ? `se agregaron ${formatWhole(result.created)} ${result.created === 1 ? "producto" : "productos"}` : null,
        result.updated > 0 ? `se puso lo que hay de ${formatWhole(result.updated)} que ya ${result.updated === 1 ? "estaba" : "estaban"}` : null,
      ].filter(Boolean)
      const sentence = parts.length > 0 ? parts.join(" y ") : "no cambió nada"
      toast.success(
        `En ${branchName} ${sentence}.${pending > 0 ? (pending === 1 ? " Quedó 1 fila por revisar: corrígela en tu hoja y pégala otra vez." : ` Quedaron ${formatWhole(pending)} filas por revisar: corrígelas en tu hoja y pégalas otra vez.`) : ""}`,
      )
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
      onClose()
    },
  })

  const columns = React.useMemo<ColumnDef<Row>[]>(
    () => [
      { id: "nombre", header: "Nombre", meta: { view: { role: "title" } }, cell: ({ row }) => row.original.input.name ?? <span className="text-muted-foreground">—</span> },
      {
        id: "unidad",
        header: "Se usa por",
        meta: { view: { primary: true, label: "Se usa por" } },
        cell: ({ row }) => {
          const review = row.original.review
          if (!review) return row.original.input.unit ?? "—"
          const said = review.purchaseUnit && review.purchaseFactor > 1 ? `${review.purchaseUnit} de ${formatWhole(review.purchaseFactor)}` : review.unit
          return (
            <span>
              {said}
              {review.unitReview ? <span className="block text-xs text-warning">por revisar</span> : null}
            </span>
          )
        },
      },
      {
        id: "hay",
        header: () => <span className="block text-right">Hay</span>,
        meta: { view: { primary: true, label: "Hay" } },
        cell: ({ row }) => (
          <span className="block tabular-nums md:text-right">
            <span className="md:hidden">Hay </span>
            {/* Lo que entrará, ya en la unidad de uso: «1100» en «caja de 100» son 110000 guantes. */}
            {row.original.review?.onHand != null ? unitsText(row.original.review.onHand, row.original.review.unit) : (row.original.input.onHand ?? "—")}
          </span>
        ),
      },
      {
        id: "minimo",
        header: () => <span className="block text-right">Mínimo</span>,
        meta: { view: { primary: true, label: "Mínimo" } },
        cell: ({ row }) => (
          <span className="block tabular-nums md:text-right">
            <span className="md:hidden">mín. </span>
            {row.original.review?.minQuantity != null ? unitsText(row.original.review.minQuantity, row.original.review.unit) : (row.original.input.minQuantity ?? "—")}
          </span>
        ),
      },
      {
        id: "estado",
        header: () => <span className="sr-only">Estado</span>,
        meta: { view: { primary: true, label: "Estado" } },
        cell: ({ row }) => <RowState row={row.original} decision={draft.decisions[row.original.index]} onDecide={(decision) => decide(row.original.index, decision)} />,
      },
    ],
    [draft.decisions, decide],
  )
  // Sin paginación: reiniciar la página con cada lista nueva re-renderiza sin fin (las filas son otro arreglo en cada render).
  const table = useReactTable({ data: rows, columns, autoResetPageIndex: false, getCoreRowModel: getCoreRowModel(), getRowId: (row) => String(row.index) })

  return (
    <FormDrawer
      open
      dock={false}
      onClose={onClose}
      className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(60rem,calc(100vw-2rem))]"
      title="Pegar tu lista"
      description={`${branchName} · Copia las columnas de tu hoja y pégalas aquí.`}
      error={save.error ? inventoryErrorMessage(save.error) : !mapped && sheet.length > 0 ? "Elige qué columna es el nombre y cuál es lo que hay: «Cambiar columnas»." : null}
      isSubmitting={save.isPending}
      submitDisabled={ready.length === 0 || !mapped || preview.isFetching}
      submitLabel={ready.length === 1 ? "Agregar 1 producto" : `Agregar ${formatWhole(ready.length)} productos`}
      cancelLabel="Cancelar"
      onSubmit={(event) => {
        event.preventDefault()
        if (save.isPending || ready.length === 0) return
        save.mutate()
      }}
    >
      <FieldGroup className="gap-5">
        {draft.text.trim() === "" ? (
          <Field>
            <FieldLabel htmlFor={`${ids}-pegar`}>Pega aquí tu lista</FieldLabel>
            <Textarea
              id={`${ids}-pegar`}
              rows={8}
              autoFocus
              placeholder={"Nombre\tUnidad\tHay\tMínimo\nGuantes de nitrilo\tcaja de 100\t11\t10"}
              aria-describedby={`${ids}-pegar-ayuda`}
              value={draft.text}
              onPaste={(event) => {
                const text = event.clipboardData.getData("text/plain")
                if (!text) return
                event.preventDefault()
                setText(text)
              }}
              onChange={(event) => setText(event.target.value)}
            />
            <FieldDescription id={`${ids}-pegar-ayuda`}>
              Selecciona en tu hoja las columnas Nombre y Hay (y, si las tienes, Unidad y Mínimo), cópialas y pégalas con Ctrl+V. Lo demás (código, proveedor, precio) se completa
              después o llega con la primera compra.
            </FieldDescription>
          </Field>
        ) : (
          <div className="flex flex-col gap-2 rounded-md bg-muted/50 px-3 py-2.5 text-sm">
            <strong>Pegado de tu hoja: {formatWhole(sheet.length - (draft.header ? 1 : 0))} filas</strong>
            <span className="flex flex-wrap items-center gap-x-2">
              Se reconocieron las columnas {recognizedText(draft.columns)}.
              <Button type="button" variant="link" className="h-auto min-h-11 p-0 sm:min-h-0" aria-expanded={changing} onClick={() => setChanging((value) => !value)}>
                Cambiar columnas
              </Button>
              <Button type="button" variant="link" className="h-auto min-h-11 p-0 sm:min-h-0" onClick={() => setText("")}>
                Pegar otra lista
              </Button>
            </span>
            {tooMany ? <span className="text-warning">Se pegan hasta {formatWhole(PASTE_MAX_ROWS)} filas por vez: se toman las primeras. Pega el resto después.</span> : null}
          </div>
        )}

        {changing && draft.text.trim() !== "" ? (
          <div className="flex flex-col gap-3 rounded-md border p-3">
            <Field orientation="horizontal">
              <Checkbox id={`${ids}-titulos`} checked={draft.header} onCheckedChange={(checked) => setDraft((current) => ({ ...current, header: checked === true, decisions: {} }))} />
              <FieldLabel htmlFor={`${ids}-titulos`} className="font-normal">
                La primera fila son los títulos
              </FieldLabel>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {draft.columns.map((column, index) => {
                const sample = sheet[0]?.[index] ?? ""
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: una columna de la hoja es su lugar.
                  <Field key={index} className="gap-1">
                    <FieldLabel htmlFor={`${ids}-columna-${index}`}>
                      Columna {index + 1}
                      {sample ? <span className="truncate font-normal text-muted-foreground">«{sample}»</span> : null}
                    </FieldLabel>
                    <ChoiceSelect
                      id={`${ids}-columna-${index}`}
                      value={column}
                      onChange={(event) =>
                        setDraft((current) => {
                          const next = event.target.value as PasteColumn
                          // Cada significado va en una sola columna: la que lo tenía queda sin usar.
                          const columns = current.columns.map((value, at) => (at === index ? next : value === next && next !== "ignorar" ? "ignorar" : value))
                          return { ...current, columns, decisions: {} }
                        })
                      }
                    >
                      {PASTE_COLUMN_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </ChoiceSelect>
                  </Field>
                )
              })}
            </div>
          </div>
        ) : null}

        {rows.length > 0 && mapped ? (
          <>
            {preview.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {inventoryErrorMessage(preview.error)}{" "}
                <Button type="button" variant="link" size="sm" onClick={() => void preview.refetch()}>
                  Reintentar
                </Button>
              </p>
            ) : null}
            <DataTable table={table} isFetching={preview.isFetching} refreshMessage="Revisando la lista…" />
            <p className="text-sm text-muted-foreground" role="status">
              {formatWhole(ready.length)} {ready.length === 1 ? "lista" : "listas"} para agregar
              {pending > 0 ? ` y ${formatWhole(pending)} por revisar` : ""}. Lo que revises aquí se queda aunque cierres la ventana.
            </p>
          </>
        ) : null}
      </FieldGroup>
    </FormDrawer>
  )
}

function RowState({ row, decision, onDecide }: { row: Row; decision: Decision | undefined; onDecide: (decision: Decision | undefined) => void }) {
  const review = row.review
  if (!review) return <span className="text-xs text-muted-foreground">Revisando…</span>
  if (review.status === "invalido") return <Chip tone="bad">{review.reason ?? "No sirve"}</Chip>
  if (review.status === "existe") return <Chip tone="soft">Ya está: se pone lo que hay</Chip>
  if (review.status === "parecido" && review.similarTo) {
    if (!decision) {
      return (
        <span className="flex flex-wrap items-center gap-1.5">
          <Chip tone="warn">¿Es «{review.similarTo.name}»?</Chip>
          <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-7" onClick={() => onDecide("mismo")}>
            Es el mismo
          </Button>
          <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-7" onClick={() => onDecide("otro")}>
            Es otro
          </Button>
        </span>
      )
    }
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        <Chip tone={decision === "mismo" ? "soft" : "ok"}>{decision === "mismo" ? `Es «${review.similarTo.name}»` : "Nuevo"}</Chip>
        <Button type="button" size="sm" variant="ghost" className="min-h-11 sm:min-h-7" onClick={() => onDecide(undefined)}>
          Cambiar
        </Button>
      </span>
    )
  }
  return review.minQuantity === null ? <Chip tone="muted">Sin mínimo</Chip> : <Chip tone="ok">Nuevo</Chip>
}
