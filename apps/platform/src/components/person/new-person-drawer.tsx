import { Field, FieldDescription, FieldLabel, Input } from "@odentia/ui"
import { FormDrawer, internationalText, normalizeCountry, PhoneInput } from "@odentia/ui-patterns"
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { apiFetch } from "../../lib/api"
import { useOrgProfile } from "../../lib/org"
import { hcLabel } from "../../lib/patients"
import { PERSON_KIND_LABELS, type PersonListItem } from "../../lib/people"
import { mutationErrorMessage } from "../../lib/query-error"

const EMPTY = { paternalSurname: "", maternalSurname: "", givenNames: "", email: "" }

/**
 * «Nueva persona»: su nombre separado y cómo ubicarla, con las reglas de la
 * ficha. Antes de crearla muestra a quien ya coincide por nombre o teléfono,
 * para no duplicar a nadie. Al guardar se abre su página, donde se registra
 * como paciente sin volver a escribir nada.
 */
export function NewPersonDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const profile = useOrgProfile()
  const countryCode = normalizeCountry(profile.data?.countryCode)
  const [values, setValues] = useState(EMPTY)
  const [phone, setPhone] = useState<string | null>(null)
  const [probe, setProbe] = useState("")
  useEffect(() => {
    if (!open) {
      setValues(EMPTY)
      setPhone(null)
    }
  }, [open])
  // Coincidencias: por teléfono si lo hay; si no, por apellido.
  useEffect(() => {
    const next = phone ? phone.replace(/\D/g, "").slice(-8) : values.paternalSurname.trim()
    const timer = setTimeout(() => setProbe(next.length >= 3 ? next : ""), 300)
    return () => clearTimeout(timer)
  }, [phone, values.paternalSurname])
  const matches = useQuery({
    queryKey: ["people", "probe", probe],
    queryFn: () =>
      apiFetch<{ data: PersonListItem[] }>(
        `/api/people?ver=todos&limit=5&q=${encodeURIComponent(probe)}`,
      ),
    enabled: open && probe.length >= 3,
    placeholderData: keepPreviousData,
  })
  const create = useMutation({
    mutationFn: () =>
      apiFetch<{ data: { id: string } }>("/api/people", {
        method: "POST",
        body: JSON.stringify({
          paternalSurname: values.paternalSurname || null,
          maternalSurname: values.maternalSurname || null,
          givenNames: values.givenNames || null,
          phone,
          email: values.email || null,
        }),
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["people"] })
      onClose()
      void navigate({ to: "/people/$personId", params: { personId: result.data.id } })
    },
  })
  const set = (key: keyof typeof EMPTY) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setValues((prev) => ({ ...prev, [key]: event.target.value }))
  const ready = Boolean(
    values.givenNames.trim() && (values.paternalSurname.trim() || values.maternalSurname.trim()),
  )
  const found = probe ? (matches.data?.data ?? []) : []
  return (
    <FormDrawer
      open={open}
      onClose={() => {
        if (!create.isPending) onClose()
      }}
      title="Nueva persona"
      description="Su nombre y cómo ubicarla. Después, en su página, la registras como paciente con lo que ya sabes."
      submitLabel="Crear y abrir su página"
      isSubmitting={create.isPending}
      submitDisabled={!ready}
      isDirty={Boolean(values.givenNames || values.paternalSurname || phone)}
      error={create.error ? mutationErrorMessage(create.error) : null}
      onSubmit={(event) => {
        event.preventDefault()
        if (ready) create.mutate()
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="new-person-paternal">Apellido paterno</FieldLabel>
          <Input
            id="new-person-paternal"
            maxLength={100}
            value={values.paternalSurname}
            onChange={set("paternalSurname")}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="new-person-maternal">Apellido materno</FieldLabel>
          <Input
            id="new-person-maternal"
            maxLength={100}
            value={values.maternalSurname}
            onChange={set("maternalSurname")}
          />
        </Field>
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor="new-person-given">Nombres</FieldLabel>
          <Input
            id="new-person-given"
            maxLength={100}
            value={values.givenNames}
            onChange={set("givenNames")}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="new-person-phone">Teléfono</FieldLabel>
          <PhoneInput
            id="new-person-phone"
            value={phone}
            defaultCountry={countryCode}
            onChange={setPhone}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="new-person-email">Correo</FieldLabel>
          <Input
            id="new-person-email"
            type="email"
            maxLength={200}
            value={values.email}
            onChange={set("email")}
          />
        </Field>
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
