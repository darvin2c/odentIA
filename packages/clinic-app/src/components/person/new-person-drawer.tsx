import { FieldDescription } from "@odentia/ui"
import { FormDrawer, internationalText, normalizeCountry, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { z } from "zod"
import { apiFetch } from "../../lib/api"
import { useOrgProfile } from "../../lib/org"
import { hcLabel } from "../../lib/patients"
import { PERSON_KIND_LABELS, type PersonListItem } from "../../lib/people"
import { refineNewPerson } from "./new-person-schema"

const EMPTY = { givenNames: "", familyName: "", phone: null as string | null, email: "" }

/**
 * «Nuevo contacto»: nombres, apellidos y cómo ubicarla, con las reglas de la
 * ficha. Antes de crearla muestra a quien ya coincide por nombre o teléfono,
 * para no duplicar a nadie. Al guardar se abre su página, donde se registra
 * como paciente sin volver a escribir nada.
 */
export function NewPersonDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const profile = useOrgProfile()
  const countryCode = normalizeCountry(profile.data?.countryCode)
  const schema = z
    .object({
      givenNames: z.string().max(100),
      familyName: z.string().max(200),
      phone: z.string().nullable(),
      email: z.string().max(200),
    })
    .superRefine((value, ctx) => refineNewPerson(value, ctx, countryCode))
  const create = useMutation({
    mutationFn: (value: typeof EMPTY) =>
      apiFetch<{ data: { id: string } }>("/api/people", {
        method: "POST",
        body: JSON.stringify({
          familyName: value.familyName.trim() || null,
          givenNames: value.givenNames.trim() || null,
          phone: value.phone,
          email: value.email.trim() || null,
        }),
      }),
  })
  const form = useAppForm({
    defaultValues: EMPTY,
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const result = await create.mutateAsync(value)
      void queryClient.invalidateQueries({ queryKey: ["people"] })
      onClose()
      void navigate({ to: "/people/$personId", params: { personId: result.data.id } })
    },
  })
  // El nombre completo que pasa de 200 se dice en los apellidos, donde se acorta.
  const surface = useFormSurface(form, { fieldMap: { displayName: "familyName" } })
  const phone = useStore(form.store, (state) => state.values.phone)
  const familyName = useStore(form.store, (state) => state.values.familyName)
  const [probe, setProbe] = useState("")
  useEffect(() => {
    if (!open) form.reset()
  }, [open, form])
  // Coincidencias: por teléfono si lo hay; si no, por apellido.
  useEffect(() => {
    const next = phone ? phone.replace(/\D/g, "").slice(-8) : familyName.trim()
    const timer = setTimeout(() => setProbe(next.length >= 3 ? next : ""), 300)
    return () => clearTimeout(timer)
  }, [phone, familyName])
  const matches = useQuery({
    queryKey: ["people", "probe", probe],
    queryFn: () =>
      apiFetch<{ data: PersonListItem[] }>(
        `/api/people?ver=todos&limit=5&q=${encodeURIComponent(probe)}`,
      ),
    enabled: open && probe.length >= 3,
    placeholderData: keepPreviousData,
  })
  const found = probe ? (matches.data?.data ?? []) : []
  return (
    <FormDrawer
      {...surface}
      open={open}
      onClose={() => {
        if (!surface.isSubmitting) onClose()
      }}
      title="Nuevo contacto"
      description="Alguien que aún no es paciente: quien pregunta, o un familiar. Si viene a atenderse, usa «Nuevo paciente»."
      submitLabel="Crear y abrir su página"
    >
      {/* Como en el registro: primero los nombres, luego los apellidos. */}
      <div className="grid gap-4 sm:grid-cols-2">
        <form.AppField name="givenNames">
          {(field) => <field.TextField label="Nombres" className="sm:col-span-2" maxLength={100} />}
        </form.AppField>
        <form.AppField name="familyName">
          {(field) => <field.TextField label="Apellidos" className="sm:col-span-2" maxLength={200} />}
        </form.AppField>
        {/* El teléfono ocupa la fila: con el país al lado, a media fila el número no cabe. */}
        <form.AppField name="phone">
          {(field) => <field.PhoneField label="Teléfono" className="sm:col-span-2" defaultCountry={countryCode} />}
        </form.AppField>
        <form.AppField name="email">
          {(field) => (
            <field.TextField label="Correo" className="sm:col-span-2" type="email" maxLength={200} />
          )}
        </form.AppField>
        {found.length > 0 ? (
          <div className="flex flex-col gap-2 rounded-md border border-warning/30 bg-warning-soft p-3 text-sm sm:col-span-2">
            <p className="font-medium">¿Es alguna de estas personas?</p>
            <ul className="flex flex-col gap-1">
              {found.map((row) => (
                <li key={row.id}>
                  <Link
                    to="/people/$personId"
                    params={{ personId: row.id }}
                    className="font-medium text-primary hover:underline"
                    onClick={onClose}
                  >
                    {row.displayName}
                  </Link>
                  <span className="text-muted-foreground">
                    {" · "}
                    {[
                      PERSON_KIND_LABELS[row.kind],
                      row.patient ? hcLabel(row.patient.patientNumber) : null,
                      row.phone ? internationalText(row.phone) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
            <FieldDescription>
              Si es una de ellas, abre su página en vez de crearla otra vez.
            </FieldDescription>
          </div>
        ) : null}
      </div>
    </FormDrawer>
  )
}
