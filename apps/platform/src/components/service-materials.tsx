/**
 * «Materiales que usa · cada vez que se hace» (ADR 0067, tablero 17): lo que
 * un servicio gasta de cada producto, que se descuenta solo al cerrar la
 * atención. Lo edita quien lleva el inventario (`inventory.write`) dentro del
 * formulario del servicio, que lo guarda con su mismo «Guardar»; quien ve
 * Inventario lo lee. El costo por vez solo lo ve quien ve precios, y lo
 * calcula el servidor con los últimos precios de compra.
 */
import { formatMoney, unitFor } from "@odentia/clinical"
import {
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Skeleton,
} from "@odentia/ui"
import { ResourceSelect } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, X } from "lucide-react"
import { Fragment, useDeferredValue, useEffect, useId, useRef, useState } from "react"
import { financeErrorMessage } from "../lib/finance"
import {
  copiedMaterialsWords,
  formatShare,
  type MaterialDraftLine,
  mergeCopiedMaterials,
  parseWholeQuantity,
  withoutMaterialsIntro,
  withoutMaterialsTitle,
} from "../lib/materials"
import {
  fetchMaterialProducts,
  fetchServiceMaterials,
  fetchServicesWithoutMaterials,
  SERVICE_MATERIALS_MAX,
  type ServiceMaterials,
} from "../lib/services"
import { ServiceSelect } from "./service-select"

const HELP =
  "Se descuentan solos al cerrar la atención, del lote que vence primero en la sede de la atención. Tres sellantes descuentan tres veces."

/** La unidad que acompaña a lo escrito: «guante» con 1, «guantes» con lo demás (o vacío). */
function unitAfter(text: string, unit: string, locale: string): string {
  const quantity = parseWholeQuantity(text, locale)
  return unitFor(quantity ?? 2, unit)
}

/**
 * Buscar un producto que se usa en las atenciones (activo), por nombre o
 * código. Lo ofrece quien lleva el inventario (`inventory.write`).
 */
export function MaterialProductPicker({
  id,
  label = "Material",
  excludeIds,
  onPick,
}: {
  id: string
  label?: string
  /** Lo que ya está en la lista no se ofrece otra vez. */
  excludeIds: readonly string[]
  onPick: (product: { productId: string; name: string; unit: string }) => void
}) {
  const [query, setQuery] = useState("")
  const q = useDeferredValue(query.trim())
  const products = useQuery({
    queryKey: ["services", "material-products", q],
    queryFn: () => fetchMaterialProducts(q, 20),
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  })
  const items = (products.data?.data ?? []).filter((item) => !excludeIds.includes(item.productId))
  return (
    <div className="grid gap-1.5">
      <ResourceSelect
        id={id}
        label={label}
        value=""
        options={items.map((item) => ({
          id: item.productId,
          label: item.name,
          detail: `Se cuenta por ${item.unit}`,
        }))}
        onQueryChange={setQuery}
        onChange={(productId) => {
          const found = items.find((item) => item.productId === productId)
          if (found) onPick(found)
        }}
        empty={
          products.isPending
            ? "Buscando productos…"
            : q
              ? `Ningún producto que se use en las atenciones coincide con «${q}».`
              : "Aún no hay productos que se usen en las atenciones. Se crean en Inventario."
        }
      />
      {products.isError && !products.data ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          No se pudieron buscar los productos.
          <Button type="button" size="sm" variant="outline" onClick={() => void products.refetch()}>
            Reintentar
          </Button>
        </p>
      ) : null}
    </div>
  )
}

/**
 * La lista editable: cada material con cuánto se usa cada vez en su unidad,
 * quitar, «+ Agregar material» y «Copiar de otro servicio». Lo escrito vive en
 * el formulario del servicio (`lines`/`onChange`) y se guarda con él.
 */
export function ServiceMaterialsEditor({
  idPrefix,
  serviceId,
  lines,
  onChange,
  errors,
  saveError,
  loading,
  loadError,
  onRetry,
  disabled,
  locale,
  reveal = false,
}: {
  idPrefix: string
  /** El servicio que se edita; null en el alta (no hay de dónde excluirse al copiar). */
  serviceId: string | null
  lines: readonly MaterialDraftLine[]
  onChange: (lines: MaterialDraftLine[]) => void
  /** El error de cada fila, por producto. */
  errors: Record<string, string>
  /** Lo que respondió el servidor al guardarlos, si no los aceptó. */
  saveError: string | null
  loading: boolean
  loadError: unknown
  onRetry: () => void
  disabled: boolean
  locale: string
  /** Se abrió desde «Empieza por estos 5»: la sección se muestra sin bajar a buscarla. */
  reveal?: boolean
}) {
  const queryClient = useQueryClient()
  const sectionRef = useRef<HTMLFieldSetElement>(null)
  useEffect(() => {
    if (!reveal || loading) return
    // Solo se desplaza el formulario: la lista de servicios de atrás no se mueve.
    const section = sectionRef.current
    let box = section?.parentElement ?? null
    while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY)))
      box = box.parentElement
    if (!section || !box) return
    const top = box.scrollTop + section.getBoundingClientRect().top - box.getBoundingClientRect().top - 16
    box.scrollTo({ top, behavior: "smooth" })
  }, [reveal, loading])
  const [adding, setAdding] = useState<"material" | "copiar" | null>(null)
  const [copyNote, setCopyNote] = useState<string | null>(null)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [copying, setCopying] = useState(false)
  const full = lines.length >= SERVICE_MATERIALS_MAX
  const helpId = `${idPrefix}-materiales-ayuda`

  const focusQuantity = (productId: string) => {
    // La fila nueva se pinta en el siguiente cuadro: ahí se escribe la cantidad.
    requestAnimationFrame(() => {
      document.getElementById(`${idPrefix}-material-${productId}`)?.focus()
    })
  }

  const patch = (productId: string, quantityText: string) =>
    onChange(lines.map((line) => (line.productId === productId ? { ...line, quantityText } : line)))

  const copyFrom = async (service: { id: string; name: string }) => {
    setCopying(true)
    setCopyError(null)
    try {
      const result = await queryClient.fetchQuery({
        queryKey: ["services", "materials", service.id],
        queryFn: () => fetchServiceMaterials(service.id),
        staleTime: 10_000,
      })
      const merged = mergeCopiedMaterials(lines, result.data.items, locale)
      const room = SERVICE_MATERIALS_MAX - lines.length
      // Más de los que admite un servicio no entra: se copia hasta el tope.
      const capped =
        merged.added > room ? merged.lines.slice(0, SERVICE_MATERIALS_MAX) : merged.lines
      onChange(capped)
      setCopyNote(
        copiedMaterialsWords(service.name, { ...merged, added: Math.min(merged.added, room) }),
      )
      setAdding(null)
    } catch (error) {
      setCopyError(financeErrorMessage(error))
    } finally {
      setCopying(false)
    }
  }

  return (
    <fieldset
      ref={sectionRef}
      className="flex min-w-0 flex-col gap-3 rounded-xl border p-3"
      aria-describedby={helpId}
    >
      <legend className="px-1 text-sm font-semibold">
        Materiales que usa · cada vez que se hace
      </legend>
      {loading ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : loadError ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          No se pudieron ver sus materiales. {financeErrorMessage(loadError)}
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            Reintentar
          </Button>
        </p>
      ) : (
        <>
          {lines.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Sin materiales: al cerrar la atención no se descuenta nada. Agrega lo que se usa cada
              vez.
            </p>
          ) : (
            <ul className="flex flex-col gap-2" aria-label="Materiales">
              {lines.map((line) => {
                const inputId = `${idPrefix}-material-${line.productId}`
                const error = errors[line.productId] ?? null
                return (
                  <li key={line.productId} className="flex flex-col gap-1">
                    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,9rem)_auto] items-start gap-2">
                      <div className="min-w-0 py-1.5 text-sm">
                        <span className="block break-words font-medium">{line.name}</span>
                        {line.discounted ? null : (
                          <span className="block text-xs text-muted-foreground">
                            No se descuenta: está desactivado o ya no se usa en las atenciones.
                          </span>
                        )}
                      </div>
                      <Field data-invalid={error ? true : undefined}>
                        <FieldLabel htmlFor={inputId} className="sr-only">
                          Cuánto se usa de {line.name} cada vez, en {unitFor(2, line.unit)}
                        </FieldLabel>
                        <InputGroup>
                          <InputGroupInput
                            id={inputId}
                            inputMode="numeric"
                            autoComplete="off"
                            className="tabular-nums"
                            value={line.quantityText}
                            disabled={disabled}
                            aria-invalid={error ? true : undefined}
                            aria-describedby={error ? `${inputId}-error` : undefined}
                            onChange={(event) => patch(line.productId, event.target.value)}
                          />
                          <InputGroupAddon align="inline-end">
                            {unitAfter(line.quantityText, line.unit, locale)}
                          </InputGroupAddon>
                        </InputGroup>
                      </Field>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="mt-0.5"
                        aria-label={`Quitar ${line.name}`}
                        disabled={disabled}
                        onClick={() =>
                          onChange(lines.filter((item) => item.productId !== line.productId))
                        }
                      >
                        <X aria-hidden />
                      </Button>
                    </div>
                    {error ? <FieldError id={`${inputId}-error`}>{error}</FieldError> : null}
                  </li>
                )
              })}
            </ul>
          )}

          {adding === "material" ? (
            <div className="flex flex-col gap-2 rounded-xl border bg-muted/40 p-3">
              <Field>
                <MaterialProductPicker
                  id={`${idPrefix}-agregar-material`}
                  excludeIds={lines.map((line) => line.productId)}
                  onPick={(product) => {
                    onChange([
                      ...lines,
                      {
                        productId: product.productId,
                        name: product.name,
                        unit: product.unit,
                        quantityText: "1",
                        discounted: true,
                      },
                    ])
                    setAdding(null)
                    setCopyNote(null)
                    focusQuantity(product.productId)
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
                onClick={() => setAdding(null)}
              >
                Cancelar
              </Button>
            </div>
          ) : adding === "copiar" ? (
            <div className="flex flex-col gap-2 rounded-xl border bg-muted/40 p-3">
              <Field data-invalid={copyError ? true : undefined}>
                <ServiceSelect
                  id={`${idPrefix}-copiar-de`}
                  label="Copiar los materiales de"
                  value=""
                  excludeId={serviceId}
                  onChange={(service) => {
                    if (service && !copying) void copyFrom(service)
                  }}
                />
                {copyError ? (
                  <FieldError>{copyError}</FieldError>
                ) : (
                  <FieldDescription>
                    {copying
                      ? "Copiando sus materiales…"
                      : "Se suman a esta lista; lo que ya está queda con su cantidad."}
                  </FieldDescription>
                )}
              </Field>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-start"
                disabled={copying}
                onClick={() => {
                  setAdding(null)
                  setCopyError(null)
                }}
              >
                Cancelar
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled || full}
                onClick={() => {
                  setCopyNote(null)
                  setAdding("material")
                }}
              >
                <Plus aria-hidden />
                Agregar material
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled || full}
                onClick={() => {
                  setCopyNote(null)
                  setCopyError(null)
                  setAdding("copiar")
                }}
              >
                Copiar de otro servicio
              </Button>
            </div>
          )}
          {full ? (
            <p className="text-xs text-muted-foreground">
              Un servicio admite hasta {SERVICE_MATERIALS_MAX} materiales.
            </p>
          ) : null}
          {copyNote ? (
            <p role="status" className="text-sm">
              {copyNote}
            </p>
          ) : null}
          {saveError ? (
            <p role="alert" className="text-sm text-destructive">
              No se guardaron los materiales: {saveError}
            </p>
          ) : null}
        </>
      )}
      <p id={helpId} className="text-xs text-muted-foreground">
        {HELP}
      </p>
    </fieldset>
  )
}

/**
 * «Cuesta en materiales» (solo para quien ve precios): lo que cuesta cada vez
 * con los últimos precios de compra y qué parte del precio del servicio es.
 */
export function ServiceMaterialsCost({
  cost,
  count,
  servicePriceCents,
  serviceCurrency,
  changed,
  locale,
}: {
  cost: ServiceMaterials["cost"]
  /** Cuántos materiales tiene guardados. */
  count: number
  servicePriceCents: number | null
  serviceCurrency: string | null
  /** Hay cambios sin guardar en la lista: la cifra es la de lo guardado. */
  changed: boolean
  locale: string
}) {
  if (count === 0 && !changed) return null
  return (
    <section
      aria-label="Cuesta en materiales"
      className="flex flex-col gap-1 rounded-xl border p-3"
    >
      <h4 className="text-sm font-semibold">Cuesta en materiales</h4>
      {cost ? (
        <>
          <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="text-base font-semibold tabular-nums">
              {formatMoney(cost.cents, cost.currency, locale)} cada vez
            </span>
            {cost.shareOfPrice !== null ? (
              <span className="text-sm tabular-nums text-muted-foreground">
                {formatShare(cost.shareOfPrice, locale, 1)} del precio
              </span>
            ) : null}
          </p>
          <p className="text-xs text-muted-foreground">
            Con los últimos precios de compra
            {servicePriceCents !== null && serviceCurrency
              ? ` · precio del servicio ${formatMoney(servicePriceCents, serviceCurrency, locale)}`
              : ""}
            {cost.unpriced > 0
              ? cost.unpriced === 1
                ? ". 1 material aún no tiene una compra con precio y no entra en la suma."
                : `. ${cost.unpriced} materiales aún no tienen una compra con precio y no entran en la suma.`
              : "."}
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {count === 0
            ? "Se calcula al guardar sus materiales."
            : "Aún sin costo: ningún material tiene una compra con precio. Llega con la primera compra."}
        </p>
      )}
      {changed && count > 0 ? (
        <p className="text-xs text-muted-foreground">Es lo guardado: se recalcula al guardar.</p>
      ) : null}
    </section>
  )
}

/**
 * «Empieza por estos 5» (tablero 17): los servicios más hechos del último mes
 * que todavía no tienen materiales, y qué parte de las atenciones son. Cada
 * uno abre su formulario. Sin servicios por configurar no se muestra: es una
 * sugerencia, no un aviso que pida algo.
 */
export function ServicesWithoutMaterialsCard({
  locale,
  onOpen,
}: {
  locale: string
  onOpen: (serviceId: string) => void
}) {
  const titleId = useId()
  const query = useQuery({
    queryKey: ["services", "without-materials"],
    queryFn: fetchServicesWithoutMaterials,
    staleTime: 60_000,
  })
  if (query.isPending) return null
  if (query.isError) {
    return (
      <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        No se pudo ver qué servicios conviene configurar primero.
        <Button type="button" size="sm" variant="outline" onClick={() => void query.refetch()}>
          Reintentar
        </Button>
      </p>
    )
  }
  const result = query.data.data
  const services = result.services
  if (services.length === 0) return null
  return (
    <section
      aria-labelledby={titleId}
      className="elevated flex flex-col gap-1.5 rounded-xl border bg-card p-4"
    >
      <h2 id={titleId} className="text-sm font-semibold">
        {withoutMaterialsTitle(services.length)}
      </h2>
      <p className="text-sm leading-relaxed">
        {withoutMaterialsIntro(result, locale)}{" "}
        {services.map((service, index) => (
          <Fragment key={service.serviceId}>
            {index === 0 ? null : index === services.length - 1 ? " y " : ", "}
            <Button
              type="button"
              variant="link"
              className="h-auto whitespace-normal p-0 text-left align-baseline"
              aria-label={`Poner los materiales de ${service.name} (se hizo ${service.times} ${service.times === 1 ? "vez" : "veces"})`}
              onClick={() => onOpen(service.serviceId)}
            >
              {service.name}
            </Button>
            <span className="tabular-nums text-muted-foreground">{` (${service.times})`}</span>
          </Fragment>
        ))}
        .
      </p>
      <p className="text-xs text-muted-foreground">
        Con estos bien puestos, la mayor parte de lo que se usa ya se descuenta solo al cerrar cada
        atención.
      </p>
    </section>
  )
}

/** Para quien ve Inventario y no cambia los materiales: la lista y, con precios, su costo. */
export function ServiceMaterialsReadOnly({
  data,
  loading,
  loadError,
  onRetry,
  showCost,
  servicePriceCents,
  serviceCurrency,
  locale,
}: {
  data: ServiceMaterials | undefined
  loading: boolean
  loadError: unknown
  onRetry: () => void
  showCost: boolean
  servicePriceCents: number | null
  serviceCurrency: string | null
  locale: string
}) {
  return (
    <section
      aria-label="Materiales que usa"
      className="flex min-w-0 flex-col gap-2 rounded-xl border p-3"
    >
      <h4 className="text-sm font-semibold">Materiales que usa · cada vez que se hace</h4>
      {loading ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : loadError ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          No se pudieron ver sus materiales.
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            Reintentar
          </Button>
        </p>
      ) : !data || data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Sin materiales: al cerrar la atención no se descuenta nada. Los pone quien lleva el
          inventario.
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-1">
            {data.items.map((item) => (
              <li
                key={item.productId}
                className="flex items-baseline justify-between gap-3 text-sm"
              >
                <span className="min-w-0 break-words">
                  {item.name}
                  {item.discounted ? null : (
                    <span className="text-xs text-muted-foreground"> · no se descuenta</span>
                  )}
                </span>
                <span className="shrink-0 tabular-nums">{item.quantityText}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{HELP}</p>
        </>
      )}
      {showCost && data && data.items.length > 0 ? (
        <ServiceMaterialsCost
          cost={data.cost}
          count={data.items.length}
          servicePriceCents={servicePriceCents}
          serviceCurrency={serviceCurrency}
          changed={false}
          locale={locale}
        />
      ) : null}
    </section>
  )
}
