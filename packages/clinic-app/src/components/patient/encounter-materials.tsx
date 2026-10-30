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
  FieldLabel,
  FieldLegend,
  FieldSet,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Skeleton,
  toast,
} from "@odentia/ui"
import { FormDrawer, submitErrorMessage, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
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
import { financeFormMessage } from "../../lib/finance"
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
  /** Lo escrito en «¿cuánto se usó?». */
  quantity: string
  /** Agregado en este formulario: se puede quitar antes de guardar. */
  added: boolean
}

/** Lo que falta o sobra en lo escrito de una fila; `null` si está bien. */
function rowQuantityError(row: CorrectionRow, locale: string): string | null {
  const quantity = parseWholeQuantity(row.quantity, locale)
  if (row.quantity.trim() === "") return "Escribe cuánto se usó; 0 si no se usó."
  if (quantity === null) return "Escribe un número entero, sin decimales."
  if (quantity > MATERIAL_QUANTITY_MAX) return `Va de 0 a ${formatWholeQuantity(MATERIAL_QUANTITY_MAX, locale)}.`
  if (row.added && quantity === 0) return "Escribe cuánto se usó, o quítalo de la lista."
  return null
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
  const [picking, setPicking] = useState(false)
  const idempotencyKey = useRef("")
  const currentRef = useRef(current)
  currentRef.current = current
  // La fila que se estaba guardando cuando el servidor rechazó: su error va ahí.
  const failedRow = useRef<number | null>(null)
  const progress = useRef({ done: 0, total: 0 })

  const form = useAppForm({
    defaultValues: { rows: [] as CorrectionRow[] },
    validators: {
      onSubmit: ({ value }) => {
        const fields: Record<string, string> = {}
        value.rows.forEach((row, index) => {
          const message = rowQuantityError(row, locale)
          if (message) fields[`rows[${index}].quantity`] = message
        })
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      const changes: Array<{ index: number; row: CorrectionRow; quantity: number }> = []
      value.rows.forEach((row, index) => {
        const quantity = parseWholeQuantity(row.quantity, locale)
        if (quantity !== null && quantity !== row.recorded) changes.push({ index, row, quantity })
      })
      failedRow.current = null
      progress.current = { done: 0, total: changes.length }
      if (changes.length === 0) throw new Error("No cambiaste ninguna cantidad.")
      let last: EncounterMaterials | null = null
      try {
        for (const { index, row, quantity } of changes) {
          failedRow.current = index
          const result = await correctEncounterMaterialApi(patientId, encounterId, {
            productId: row.productId,
            quantity,
            idempotencyKey: idempotencyKey.current,
          })
          failedRow.current = null
          last = {
            branch: result.data.branch,
            items: result.data.items,
            canCorrect: result.data.canCorrect,
            canAddProducts: result.data.canAddProducts,
          }
          progress.current.done += 1
          // Lo guardado pasa a ser el punto de partida: si otro falla, este no se reenvía.
          form.setFieldValue(`rows[${index}]`, {
            ...row,
            recorded: quantity,
            added: false,
            quantity: formatWholeQuantity(quantity, locale),
          })
        }
      } catch (err) {
        if (last) {
          queryClient.setQueryData(materialsKey(patientId, encounterId), { data: last })
          onSaved?.()
        }
        void queryClient.invalidateQueries({ queryKey: materialsKey(patientId, encounterId) })
        throw err
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
    },
  })
  const surface = useFormSurface(form, {
    // Cada producto se guarda por separado: lo que el servidor dice del dato
    // (cantidad o producto) es de la fila que falló.
    fieldMap: () => (failedRow.current === null ? undefined : `rows[${failedRow.current}].quantity`),
    formMessage: (err) => {
      const { done, total } = progress.current
      const own = financeFormMessage(err)
      if (done === 0) return own
      return `Se guardaron ${done} de ${total}. ${own ?? submitErrorMessage(err)}`
    },
  })
  const saving = surface.isSubmitting

  // Al abrir: lo registrado como punto de partida y una clave nueva. Lo que
  // llegue después del servidor no pisa lo que se está escribiendo.
  useEffect(() => {
    if (!open) return
    idempotencyKey.current = crypto.randomUUID()
    form.reset({
      rows: currentRef.current.items.map((item) => ({
        productId: item.productId,
        name: item.name,
        unit: item.unit,
        recorded: item.quantity,
        quantity: formatWholeQuantity(item.quantity, locale),
        added: false,
      })),
    })
    setPicking(false)
  }, [open, locale, form])

  const rows = useStore(form.store, (state) => state.values.rows)
  const dirty = rows.some((row) => row.added || parseWholeQuantity(row.quantity, locale) !== row.recorded)

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
      {...surface}
      isDirty={dirty}
      submitLabel="Guardar"
      onClose={() => {
        if (!saving) onClose()
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
          <form.AppField name="rows" mode="array">
            {(rowsField) =>
              rowsField.state.value.map((row, index) => (
                <form.AppField key={row.productId} name={`rows[${index}].quantity`}>
                  {(field) => {
                    const typed = parseWholeQuantity(field.state.value, locale)
                    return (
                      <field.Control
                        id={`${uid}-${row.productId}`}
                        label={
                          <>
                            {row.name}
                            <span className="sr-only">, en {unitFor(2, row.unit)}</span>
                          </>
                        }
                        description={
                          row.added
                            ? "No estaba registrado en esta atención."
                            : `Registrado: ${quantityWords(row.recorded, row.unit, locale)}.`
                        }
                      >
                        {(control) => (
                          <div className="flex items-center gap-2">
                            <InputGroup className="max-w-48">
                              <InputGroupInput
                                {...control.props}
                                inputMode="numeric"
                                autoComplete="off"
                                className="tabular-nums"
                                value={field.state.value}
                                disabled={saving}
                                onChange={(event) => field.handleChange(event.target.value)}
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
                                onClick={() => rowsField.removeValue(index)}
                              >
                                <X aria-hidden />
                              </Button>
                            ) : null}
                          </div>
                        )}
                      </field.Control>
                    )
                  }}
                </form.AppField>
              ))
            }
          </form.AppField>
        </FieldSet>
        {canAddProducts ? (
          picking ? (
            <div className="flex flex-col gap-2 rounded-xl border bg-muted/40 p-3">
              <Field>
                <FieldLabel htmlFor={`${uid}-otro-producto`}>Producto</FieldLabel>
                <MaterialProductPicker
                  id={`${uid}-otro-producto`}
                  label="Producto"
                  aria-describedby={`${uid}-otro-producto-ayuda`}
                  excludeIds={rows.map((row) => row.productId)}
                  onPick={(product) => {
                    form.pushFieldValue("rows", { ...product, recorded: 0, quantity: "1", added: true })
                    setPicking(false)
                    requestAnimationFrame(() =>
                      document.getElementById(`${uid}-${product.productId}`)?.focus(),
                    )
                  }}
                />
                <FieldDescription id={`${uid}-otro-producto-ayuda`}>
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
