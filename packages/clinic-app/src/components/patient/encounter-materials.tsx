/**
 * «Materiales usados» de una atención firmada (ADR 0067, tablero 18): lo que
 * salió de la sede con el cierre, neto de lo corregido después. «Corregir»
 * («Fueron 4 guantes, no 2») lo hacen quien atendió, el dueño y la
 * administración —lo dice el servidor con `canCorrect`— y deja un ajuste unido
 * a la atención: lo firmado no cambia. Lo que se escribe es el total usado de
 * cada producto, nunca algo que se suma: así un material no se descuenta dos
 * veces. «Atención finalizada» dice lo descontado con la misma corrección a mano.
 */
import { quantityWords, unitFor } from "@odentia/clinical"
import {
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Skeleton,
  toast,
} from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, X } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { usePermission } from "../../lib/crm"
import {
  correctEncounterMaterialApi,
  type EncounterMaterials,
  fetchEncounterMaterials,
  type FinalizedMaterials,
} from "../../lib/encounters"
import { financeErrorMessage } from "../../lib/finance"
import { activeOrgLocale } from "../../lib/locale"
import {
  discountedMaterialsWords,
  formatWholeQuantity,
  materialPhrase,
  parseWholeQuantity,
  shortageWords,
} from "../../lib/materials"
import { MATERIAL_QUANTITY_MAX } from "../../lib/services"
import { MaterialProductPicker } from "../service-materials"

function materialsKey(patientId: string, encounterId: string) {
  return ["encounter-materials", patientId, encounterId] as const
}

/** Una sola lectura para el bloque, el cierre y «Corregir». */
function useEncounterMaterials(patientId: string, encounterId: string, enabled: boolean) {
  return useQuery({
    queryKey: materialsKey(patientId, encounterId),
    queryFn: () => fetchEncounterMaterials(patientId, encounterId),
    enabled,
  })
}

/**
 * El bloque en la atención firmada: cada producto con cuánto se usó y
 * «Corregir». Sin materiales y sin poder registrarlos, no aparece.
 */
export function EncounterMaterialsBlock({
  patientId,
  encounterId,
}: {
  patientId: string
  encounterId: string
}) {
  const canRead = usePermission("clinical.read")
  const locale = activeOrgLocale() ?? "es"
  const [open, setOpen] = useState(false)
  const query = useEncounterMaterials(patientId, encounterId, canRead)
  if (!canRead) return null
  if (query.isPending) {
    return (
      <section
        aria-label="Materiales usados"
        aria-busy="true"
        className="flex flex-col gap-2 rounded-lg border p-4"
      >
        <Skeleton className="h-4 w-36" />
        <Skeleton className="h-4 w-full" />
      </section>
    )
  }
  if (query.isError) {
    return (
      <section aria-label="Materiales usados" className="flex flex-col gap-2 rounded-lg border p-4">
        <h4 className="text-sm font-medium">Materiales usados</h4>
        <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          No se pudieron ver los materiales usados.
          <Button type="button" size="sm" variant="outline" onClick={() => void query.refetch()}>
            Reintentar
          </Button>
        </p>
      </section>
    )
  }
  const data = query.data.data
  const correctable = data.canCorrect && (data.items.length > 0 || data.canAddProducts)
  if (data.items.length === 0 && !correctable) return null
  return (
    <section aria-label="Materiales usados" className="flex flex-col gap-2 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <h4 className="text-sm font-medium">Materiales usados</h4>
          {data.branch ? (
            <p className="text-xs text-muted-foreground">Salieron de {data.branch.name}</p>
          ) : null}
        </div>
        {correctable ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
            {data.items.length === 0 ? "Registrar lo usado" : "Corregir"}
          </Button>
        ) : null}
      </div>
      {data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No se registró ningún material en esta atención.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {data.items.map((item) => (
            <li key={item.productId} className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 break-words">{item.name}</span>
              <span className="shrink-0 tabular-nums">{item.quantityText}</span>
            </li>
          ))}
        </ul>
      )}
      {correctable ? (
        <EncounterMaterialsDrawer
          open={open}
          onClose={() => setOpen(false)}
          patientId={patientId}
          encounterId={encounterId}
          current={data}
          canAddProducts={data.canAddProducts}
          locale={locale}
        />
      ) : null}
    </section>
  )
}

/**
 * En «Atención finalizada»: de qué sede salió lo usado, lo que no había (queda
 * como faltante) y «Corregir» ahí mismo («y una mascarilla»). Si no se pudo
 * descontar, lo dice y ofrece registrarlo. Solo informa: «Listo» nunca espera.
 */
export function FinalizedMaterialsNote({
  patientId,
  encounterId,
  materials,
  corrected,
  onCorrect,
}: {
  patientId: string
  encounterId: string
  /** Lo que devolvió el cierre. */
  materials: FinalizedMaterials
  /** Ya se corrigió desde aquí: se muestra lo registrado ahora, sin el faltante del cierre. */
  corrected: boolean
  onCorrect: () => void
}) {
  const locale = activeOrgLocale() ?? "es"
  const query = useEncounterMaterials(patientId, encounterId, true)
  const data = query.data?.data ?? null
  if (materials.failed && !(corrected && data)) {
    return (
      <div
        role="alert"
        className="flex flex-col gap-2 rounded-lg border border-warning/50 p-3 text-sm"
      >
        <p>
          No se pudieron descontar los materiales de {materials.branch.name}; la atención quedó
          firmada igual.
          {data?.canAddProducts
            ? ""
            : " Regístralos en «Materiales usados» de esta atención, en Historia."}
        </p>
        {data?.canAddProducts ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={onCorrect}
          >
            Registrar lo usado
          </Button>
        ) : null}
      </div>
    )
  }
  const shown =
    corrected && data
      ? { branch: data.branch ?? materials.branch, items: data.items }
      : { branch: materials.branch, items: materials.items }
  const shortage = corrected ? null : shortageWords(materials.items, locale)
  return (
    <section aria-label="Materiales" className="flex flex-col gap-1 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0">
          <span className="font-medium">Materiales</span>
          {" · "}
          {shown.items.length > 0
            ? discountedMaterialsWords(shown, locale)
            : "No se registró ningún material."}
        </p>
        {data?.canCorrect ? (
          <Button type="button" variant="outline" size="sm" onClick={onCorrect}>
            Corregir
          </Button>
        ) : null}
      </div>
      {shortage ? <p className="text-muted-foreground">{shortage}</p> : null}
    </section>
  )
}

/**
 * «Corregir» abierto desde fuera del bloque (el cierre): espera la lectura de
 * lo registrado y abre el mismo formulario, siempre como cajón encima de la
 * ventana que lo abre (en la columna lateral quedaría fuera de ella).
 */
export function EncounterMaterialsCorrection({
  open,
  patientId,
  encounterId,
  onClose,
  onSaved,
}: {
  open: boolean
  patientId: string
  encounterId: string
  onClose: () => void
  onSaved: () => void
}) {
  const locale = activeOrgLocale() ?? "es"
  const query = useEncounterMaterials(patientId, encounterId, open)
  const data = query.data?.data
  if (!data) return null
  return (
    <EncounterMaterialsDrawer
      open={open}
      onClose={onClose}
      onSaved={onSaved}
      patientId={patientId}
      encounterId={encounterId}
      current={data}
      canAddProducts={data.canAddProducts}
      locale={locale}
      dock={false}
    />
  )
}

interface CorrectionRow {
  productId: string
  name: string
  unit: string
  /** Lo que está registrado ahora (0 si el producto no estaba). */
  recorded: number
  text: string
  /** Agregado en este formulario: se puede quitar antes de guardar. */
  added: boolean
}

/**
 * «Corregir»: por producto, «¿cuánto se usó?» en su unidad (0 si no se usó) y
 * otro producto que no estaba. Una clave por formulario abierto: reintentar
 * lo mismo no descuenta dos veces. Cada producto se guarda por separado; lo
 * que ya quedó no se vuelve a enviar si otro falla.
 */
function EncounterMaterialsDrawer({
  open,
  onClose,
  onSaved,
  patientId,
  encounterId,
  current,
  canAddProducts,
  locale,
  dock = true,
}: {
  open: boolean
  onClose: () => void
  /** Se guardó al menos un cambio. */
  onSaved?: () => void
  /** `false`: siempre cajón (`FormDrawer`), como lo que se abre desde otra ventana. */
  dock?: boolean
  patientId: string
  encounterId: string
  current: EncounterMaterials
  canAddProducts: boolean
  locale: string
}) {
  const uid = useId()
  const queryClient = useQueryClient()
  const [rows, setRows] = useState<CorrectionRow[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [picking, setPicking] = useState(false)
  const idempotencyKey = useRef("")
  const currentRef = useRef(current)
  currentRef.current = current

  // Al abrir: lo registrado como punto de partida y una clave nueva. Lo que
  // llegue después del servidor no pisa lo que se está escribiendo.
  useEffect(() => {
    if (!open) return
    idempotencyKey.current = crypto.randomUUID()
    setRows(
      currentRef.current.items.map((item) => ({
        productId: item.productId,
        name: item.name,
        unit: item.unit,
        recorded: item.quantity,
        text: formatWholeQuantity(item.quantity, locale),
        added: false,
      })),
    )
    setErrors({})
    setError(null)
    setPicking(false)
  }, [open, locale])

  const dirty = rows.some(
    (row) => row.added || parseWholeQuantity(row.text, locale) !== row.recorded,
  )
  const patchRow = (productId: string, text: string) => {
    setRows((previous) =>
      previous.map((row) => (row.productId === productId ? { ...row, text } : row)),
    )
    setErrors((previous) => {
      const rest = { ...previous }
      delete rest[productId]
      return rest
    })
    setError(null)
  }

  const submit = async () => {
    const nextErrors: Record<string, string> = {}
    const changes: Array<{ row: CorrectionRow; quantity: number }> = []
    for (const row of rows) {
      const quantity = parseWholeQuantity(row.text, locale)
      if (row.text.trim() === "")
        nextErrors[row.productId] = "Escribe cuánto se usó; 0 si no se usó."
      else if (quantity === null)
        nextErrors[row.productId] = "Escribe un número entero, sin decimales."
      else if (quantity > MATERIAL_QUANTITY_MAX)
        nextErrors[row.productId] =
          `Va de 0 a ${formatWholeQuantity(MATERIAL_QUANTITY_MAX, locale)}.`
      else if (row.added && quantity === 0)
        nextErrors[row.productId] = "Escribe cuánto se usó, o quítalo de la lista."
      else if (quantity !== row.recorded) changes.push({ row, quantity })
    }
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return
    if (changes.length === 0) {
      setError("No cambiaste ninguna cantidad.")
      return
    }
    setSaving(true)
    setError(null)
    let last: EncounterMaterials | null = null
    let done = 0
    try {
      for (const { row, quantity } of changes) {
        const result = await correctEncounterMaterialApi(patientId, encounterId, {
          productId: row.productId,
          quantity,
          idempotencyKey: idempotencyKey.current,
        })
        last = {
          branch: result.data.branch,
          items: result.data.items,
          canCorrect: result.data.canCorrect,
          canAddProducts: result.data.canAddProducts,
        }
        done += 1
        // Lo guardado pasa a ser el punto de partida: si otro falla, este no se reenvía.
        setRows((previous) =>
          previous.map((item) =>
            item.productId === row.productId
              ? {
                  ...item,
                  recorded: quantity,
                  added: false,
                  text: formatWholeQuantity(quantity, locale),
                }
              : item,
          ),
        )
      }
      if (last) queryClient.setQueryData(materialsKey(patientId, encounterId), { data: last })
      void queryClient.invalidateQueries({ queryKey: ["inventory"] })
      const [only] = changes
      toast.success(
        changes.length > 1
          ? `Listo: se corrigieron ${changes.length} materiales. Lo firmado no cambia.`
          : only && only.quantity === 0
            ? `Listo: no se usó ${only.row.name}.`
            : only
              ? `Listo: ${only.quantity === 1 ? "se usó" : "se usaron"} ${materialPhrase({ ...only.row, quantity: only.quantity }, locale)}.`
              : "Listo.",
      )
      onSaved?.()
      onClose()
    } catch (err) {
      if (last) {
        queryClient.setQueryData(materialsKey(patientId, encounterId), { data: last })
        onSaved?.()
      }
      void queryClient.invalidateQueries({ queryKey: materialsKey(patientId, encounterId) })
      const message = financeErrorMessage(err)
      setError(done > 0 ? `Se guardaron ${done} de ${changes.length}. ${message}` : message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <FormDrawer
      open={open}
      dock={dock}
      title="Corregir materiales"
      description={
        current.branch
          ? `Lo que se corrige sale o vuelve a ${current.branch.name}, con un ajuste unido a esta atención. Lo firmado no cambia.`
          : "Queda un ajuste unido a esta atención. Lo firmado no cambia."
      }
      error={error}
      isDirty={dirty}
      isSubmitting={saving}
      submitLabel="Guardar"
      onClose={() => {
        if (!saving) onClose()
      }}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="flex flex-col gap-5">
        <FieldSet className="gap-4">
          <FieldLegend variant="label">¿Cuánto se usó?</FieldLegend>
          <FieldDescription>
            Escribe lo que de verdad se usó de cada uno; 0 si no se usó.
          </FieldDescription>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No hay materiales registrados. Agrega lo que se usó.
            </p>
          ) : null}
          {rows.map((row) => {
            const inputId = `${uid}-${row.productId}`
            const rowError = errors[row.productId] ?? null
            const typed = parseWholeQuantity(row.text, locale)
            return (
              <Field key={row.productId} data-invalid={rowError ? true : undefined}>
                <FieldLabel htmlFor={inputId}>
                  {row.name}
                  <span className="sr-only">, en {unitFor(2, row.unit)}</span>
                </FieldLabel>
                <div className="flex items-center gap-2">
                  <InputGroup className="max-w-48">
                    <InputGroupInput
                      id={inputId}
                      inputMode="numeric"
                      autoComplete="off"
                      className="tabular-nums"
                      value={row.text}
                      disabled={saving}
                      aria-invalid={rowError ? true : undefined}
                      aria-describedby={`${inputId}-ayuda`}
                      onChange={(event) => patchRow(row.productId, event.target.value)}
                    />
                    <InputGroupAddon align="inline-end">
                      {unitFor(typed ?? 2, row.unit)}
                    </InputGroupAddon>
                  </InputGroup>
                  {row.added ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Quitar ${row.name}`}
                      disabled={saving}
                      onClick={() =>
                        setRows((previous) =>
                          previous.filter((item) => item.productId !== row.productId),
                        )
                      }
                    >
                      <X aria-hidden />
                    </Button>
                  ) : null}
                </div>
                <FieldDescription id={`${inputId}-ayuda`}>
                  {row.added
                    ? "No estaba registrado en esta atención."
                    : `Registrado: ${quantityWords(row.recorded, row.unit, locale)}.`}
                </FieldDescription>
                {rowError ? <FieldError>{rowError}</FieldError> : null}
              </Field>
            )
          })}
        </FieldSet>
        {canAddProducts ? (
          picking ? (
            <div className="flex flex-col gap-2 rounded-xl border bg-muted/40 p-3">
              <Field>
                <MaterialProductPicker
                  id={`${uid}-otro-producto`}
                  label="Producto"
                  excludeIds={rows.map((row) => row.productId)}
                  onPick={(product) => {
                    setRows((previous) => [
                      ...previous,
                      { ...product, recorded: 0, text: "1", added: true },
                    ])
                    setPicking(false)
                    setError(null)
                    requestAnimationFrame(() =>
                      document.getElementById(`${uid}-${product.productId}`)?.focus(),
                    )
                  }}
                />
                <FieldDescription>
                  Solo los productos que se usan en las atenciones.
                </FieldDescription>
              </Field>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={() => setPicking(false)}
              >
                Cancelar
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              disabled={saving}
              onClick={() => setPicking(true)}
            >
              <Plus aria-hidden />
              Agregar otro producto
            </Button>
          )
        ) : null}
      </div>
    </FormDrawer>
  )
}
