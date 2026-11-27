import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  toast,
} from "@odentia/ui"
import {
  type CountryCode,
  CountrySelect,
  EmptyState,
  SectionNav,
  type SectionNavGroup,
  SubmitButton,
} from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useLocation } from "@tanstack/react-router"
import { Settings } from "lucide-react"
import { type FormEvent, type ReactNode, useId, useState } from "react"
import { useZones, zoneLabel } from "./hora"
import { api, type MyStore } from "./lib/api"
import { configGroupsFor, configSectionOf, seesSection } from "./lib/configuracion"
import { currencySymbol } from "./lib/tienda"
import { FormAlert, fieldErrors, SELECT_CLASSES } from "./piezas"
import { RouterLink, StoreHeader, useStoreContext } from "./tiendas"

/**
 * Configuración (lienzo «gestorIA como odentIA», tablero 10): el mismo armazón de las clínicas,
 * con los grupos a la izquierda y cada apartado a la derecha; en el teléfono, un selector de
 * apartado (`SectionNav`). Cada apartado lo ve quien puede cambiarlo (`lib/configuracion.ts`): a
 * quien abre uno que no es suyo se le dice, sin mostrarlo.
 */
export function ConfigFrame({ children }: { children: ReactNode }) {
  const { store } = useStoreContext()
  const { pathname } = useLocation()
  const base = `/tiendas/${store.id}`
  const groups: SectionNavGroup[] = configGroupsFor(store).map((group) => ({
    label: group.label,
    items: group.items.map((item) => ({ label: item.label, to: `${base}${item.path}` })),
  }))
  const inside = pathname.startsWith(base) ? pathname.slice(base.length).replace(/\/$/, "") : ""
  const section = configSectionOf(inside)
  const content =
    section && seesSection(store, section) ? (
      children
    ) : (
      <>
        <StoreHeader title="Configuración" />
        <EmptyState
          icon={Settings}
          title="Esto lo ajusta quien configura la tienda"
          description="Tu rol atiende y vende con lo que ya está configurado. Si algo hay que cambiar, pídeselo a quien administra la tienda."
        />
      </>
    )
  if (groups.length === 0) return <div className="flex flex-col gap-6">{content}</div>
  return (
    <SectionNav
      label="Configuración"
      groups={groups}
      items={[]}
      pathname={pathname}
      LinkComponent={RouterLink}
    >
      <div className="flex flex-col gap-6">{content}</div>
    </SectionNav>
  )
}

/** «Soles (S/)»: el nombre de la moneda y su símbolo. */
function currencyName(code: string): string {
  let name = code
  try {
    name = new Intl.DisplayNames(["es"], { type: "currency" }).of(code) ?? code
  } catch {
    // Un navegador viejo: queda el código.
  }
  const nice = name.charAt(0).toUpperCase() + name.slice(1)
  return `${nice} (${currencySymbol(code)})`
}

/**
 * Configuración › Datos de la tienda: el nombre, el país y la hora de la tienda, con la que se
 * cuentan «hoy», «mañana», los reportes y las promociones para todo el equipo (ADR 0222). La
 * moneda queda fija desde que se creó la tienda. El logo y el color van en «Tu marca».
 */
export function StoreDataPage() {
  const { store } = useStoreContext()
  // Lo guardado manda cuando cambia (al guardar o desde otra pestaña).
  return (
    <StoreDataForm key={`${store.name}|${store.country ?? ""}|${store.timeZone}`} store={store} />
  )
}

function StoreDataForm({ store }: { store: MyStore }) {
  const canEdit = store.permissions.includes("configuracion")
  const queryClient = useQueryClient()
  const id = useId()
  const [name, setName] = useState(store.name)
  const [country, setCountry] = useState<string | null>(store.country)
  const [timeZone, setTimeZone] = useState(store.timeZone)
  const [missing, setMissing] = useState<string | null>(null)
  const zones = useZones(store.timeZone)
  const dirty = name !== store.name || country !== store.country || timeZone !== store.timeZone
  const save = useMutation({
    mutationFn: () =>
      api(`/api/tiendas/${store.id}/datos`, {
        method: "PUT",
        body: { name, country, timeZone },
      }),
    onSuccess: async () => {
      // La tienda (su nombre y su hora) y todo lo que cuenta días se vuelve a pedir.
      await queryClient.invalidateQueries({ queryKey: ["yo"] })
      if (timeZone !== store.timeZone)
        await Promise.all(
          ["pedidos", "reportes", "para-vender", "argos"].map((key) =>
            queryClient.invalidateQueries({ queryKey: [key, store.id] }),
          ),
        )
      toast.success("Datos de la tienda guardados")
    },
  })
  const errors: Record<string, string> = {
    ...fieldErrors(save.error),
    ...(missing ? { name: missing } : {}),
  }
  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) {
      setMissing("Escribe el nombre de tu tienda")
      document.getElementById(`${id}-nombre`)?.focus()
      return
    }
    setMissing(null)
    save.mutate()
  }
  return (
    <>
      <StoreHeader title="Datos de la tienda" />
      <form
        noValidate
        onSubmit={onSubmit}
        className="elevated max-w-xl rounded-xl border bg-card p-5"
        aria-label="Datos de la tienda"
      >
        <FieldGroup className="gap-5">
          <FieldSet>
            <FieldLegend className="sr-only">La tienda</FieldLegend>
            <FieldGroup className="gap-5">
              <Field data-invalid={errors.name ? true : undefined}>
                <FieldLabel htmlFor={`${id}-nombre`}>Nombre de la tienda</FieldLabel>
                {canEdit ? (
                  <Input
                    id={`${id}-nombre`}
                    value={name}
                    maxLength={80}
                    onChange={(event) => setName(event.target.value)}
                    aria-invalid={errors.name ? true : undefined}
                    aria-describedby={`${id}-nombre-ayuda`}
                  />
                ) : (
                  <p id={`${id}-nombre`} className="text-sm font-medium">
                    {store.name}
                  </p>
                )}
                {errors.name ? (
                  <FieldError id={`${id}-nombre-ayuda`}>{errors.name}</FieldError>
                ) : (
                  <FieldDescription id={`${id}-nombre-ayuda`}>
                    Así se llama en gestorIA y en lo que te cobramos. El nombre que ve el cliente va
                    en «Tu marca».
                  </FieldDescription>
                )}
              </Field>
              <Field data-invalid={errors.country ? true : undefined}>
                <FieldLabel htmlFor={`${id}-pais`}>País de tu tienda</FieldLabel>
                <CountrySelect
                  id={`${id}-pais`}
                  value={(country ?? "") as CountryCode}
                  onChange={(next) => setCountry(next)}
                  disabled={!canEdit}
                  invalid={Boolean(errors.country)}
                  aria-describedby={`${id}-pais-ayuda`}
                />
                {errors.country ? (
                  <FieldError id={`${id}-pais-ayuda`}>{errors.country}</FieldError>
                ) : (
                  <FieldDescription id={`${id}-pais-ayuda`}>
                    Con él te cobramos el plan con el impuesto que corresponde.
                  </FieldDescription>
                )}
              </Field>
              <Field data-invalid={errors.timeZone ? true : undefined}>
                <FieldLabel htmlFor={`${id}-zona`}>Hora de la tienda</FieldLabel>
                {canEdit ? (
                  <select
                    id={`${id}-zona`}
                    value={timeZone}
                    onChange={(event) => setTimeZone(event.target.value)}
                    className={SELECT_CLASSES}
                    aria-describedby={`${id}-zona-ayuda`}
                    aria-invalid={errors.timeZone ? true : undefined}
                  >
                    {zones.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p id={`${id}-zona`} className="text-sm font-medium">
                    {zoneLabel(store.timeZone)}
                  </p>
                )}
                {errors.timeZone ? (
                  <FieldError id={`${id}-zona-ayuda`}>{errors.timeZone}</FieldError>
                ) : (
                  <FieldDescription id={`${id}-zona-ayuda`}>
                    Con esta hora se cuentan «hoy», «mañana», los reportes y las promociones.
                  </FieldDescription>
                )}
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-moneda`}>Moneda</FieldLabel>
                <p id={`${id}-moneda`} className="text-sm font-medium">
                  {currencyName(store.currency)}
                </p>
                <FieldDescription>Fija desde que se creó la tienda.</FieldDescription>
              </Field>
            </FieldGroup>
          </FieldSet>
          {canEdit ? (
            <>
              <FormAlert error={Object.keys(errors).length > 0 ? null : save.error} />
              <div className="flex flex-wrap items-center gap-3">
                <SubmitButton type="submit" pending={save.isPending}>
                  Guardar
                </SubmitButton>
                {dirty && !save.isPending ? (
                  <span className="text-sm font-medium text-warning">Aún no se guarda</span>
                ) : null}
              </div>
            </>
          ) : null}
        </FieldGroup>
      </form>
    </>
  )
}
