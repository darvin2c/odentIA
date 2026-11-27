import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, toast } from "@odentia/ui"
import { SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useId, useMemo, useState } from "react"
import { api, type MyStore } from "./lib/api"
import { FormAlert, fieldErrors, SELECT_CLASSES } from "./piezas"

/**
 * «Hora de la tienda» (lienzo «gestorIA como odentIA», tableros 3 y 10): con ella se cuentan
 * «hoy», «mañana», los reportes y las promociones, la misma para todo el equipo aunque alguien
 * esté en otro país. La cambia quien tiene `configuracion`; los demás la ven. Llegará a
 * «Datos de la tienda» cuando esté Configuración.
 */

/**
 * Las de la región primero, como las monedas al crear la tienda; después, todas. Buenos Aires se
 * llama distinto según el navegador: va la que conozca.
 */
const FIRST = [
  ["America/Lima"],
  ["America/Bogota"],
  ["America/Guayaquil"],
  ["America/La_Paz"],
  ["America/Santiago"],
  ["America/Argentina/Buenos_Aires", "America/Buenos_Aires"],
  ["America/Mexico_City"],
  ["America/Caracas"],
  ["Europe/Madrid"],
]

/** «Lima (UTC−5)»: la ciudad de la zona y cuánto va de UTC hoy. */
export function zoneLabel(zone: string, now = new Date()): string {
  const city = (zone.split("/").at(-1) ?? zone).replaceAll("_", " ")
  let offset = ""
  try {
    offset =
      new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
        .formatToParts(now)
        .find((p) => p.type === "timeZoneName")?.value ?? ""
  } catch {
    return city
  }
  const utc = offset.replace("GMT", "UTC").replace("-", "−")
  return `${city} (${utc})`
}

function useZones(current: string) {
  return useMemo(() => {
    // Un navegador viejo que no da la lista ofrece al menos las de la región.
    const all =
      typeof Intl.supportedValuesOf === "function"
        ? Intl.supportedValuesOf("timeZone")
        : FIRST.map(([zone]) => zone as string)
    const option = (zone: string) => ({ value: zone, label: zoneLabel(zone) })
    const firstZones = FIRST.flatMap((names) => names.find((zone) => all.includes(zone)) ?? [])
    const first = firstZones.map(option)
    const rest = all
      .filter((zone) => !firstZones.includes(zone))
      .map(option)
      .sort((a, b) => a.label.localeCompare(b.label, "es"))
    const zones = [...first, ...rest]
    // La guardada siempre está en la lista, aunque el navegador no la conozca.
    if (!zones.some((z) => z.value === current)) zones.unshift(option(current))
    return zones
  }, [current])
}

export function StoreTimeSection({ store }: { store: MyStore }) {
  const canEdit = store.permissions.includes("configuracion")
  const queryClient = useQueryClient()
  const zones = useZones(store.timeZone)
  const [zone, setZone] = useState(store.timeZone)
  const id = useId()
  const save = useMutation({
    mutationFn: () =>
      api(`/api/tiendas/${store.id}/hora`, { method: "PATCH", body: { timeZone: zone } }),
    onSuccess: async () => {
      // La tienda (su hora) y todo lo que cuenta días se vuelve a pedir.
      await queryClient.invalidateQueries({ queryKey: ["yo"] })
      await queryClient.invalidateQueries({ queryKey: ["pedidos", store.id] })
      await queryClient.invalidateQueries({ queryKey: ["reportes", store.id] })
      // Las promociones valen de un día a otro de la tienda, y Argos cuenta con ellas.
      await queryClient.invalidateQueries({ queryKey: ["para-vender", store.id] })
      await queryClient.invalidateQueries({ queryKey: ["argos", store.id] })
      toast.success(`Hora de la tienda: ${zoneLabel(zone)}`)
    },
  })
  const errors = fieldErrors(save.error)
  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    save.mutate()
  }
  return (
    <section aria-labelledby={id} className="elevated overflow-hidden rounded-xl border bg-card">
      <div className="border-b px-5 py-4">
        <h2 id={id} className="text-base font-semibold">
          Hora de la tienda
        </h2>
      </div>
      <form noValidate onSubmit={onSubmit} className="max-w-md px-5 py-4">
        <FieldGroup className="gap-4">
          <Field data-invalid={errors.timeZone ? true : undefined}>
            <FieldLabel htmlFor={`${id}-zona`}>Zona horaria</FieldLabel>
            {canEdit ? (
              <select
                id={`${id}-zona`}
                value={zone}
                onChange={(e) => setZone(e.target.value)}
                className={SELECT_CLASSES}
                aria-describedby={`${id}-ayuda`}
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
              <FieldError>{errors.timeZone}</FieldError>
            ) : (
              <FieldDescription id={`${id}-ayuda`}>
                Con esta hora se cuentan «hoy», «mañana», los reportes y las promociones.
              </FieldDescription>
            )}
          </Field>
          {canEdit ? (
            <>
              <FormAlert error={errors.timeZone ? null : save.error} />
              <SubmitButton
                type="submit"
                pending={save.isPending}
                disabled={zone === store.timeZone}
                className="self-start"
              >
                Guardar la hora
              </SubmitButton>
            </>
          ) : null}
        </FieldGroup>
      </form>
    </section>
  )
}
