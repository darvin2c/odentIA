import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FieldLabel,
  Input,
  Spinner,
} from "@odentia/ui"
import {
  internationalText,
  normalizeCountry,
  SubmitButton,
  submitErrorMessage,
  toE164,
  useAppForm,
  useFormSubmit,
  useFormSubmitError,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { ChevronRight, Search, UserPlus } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { z } from "zod"
import { ApiError, apiFetch } from "../lib/api"
import { timeAgo, usePermission } from "../lib/crm"
import type { PersonListItem } from "../lib/people"
import { useOrgProfile } from "../lib/org"
import { useWriteToPerson } from "./write-to-person"

/** ¿Lo que se escribió parece un teléfono? (dígitos, espacios, guiones, paréntesis o «+»). */
function looksLikePhone(text: string): boolean {
  return /^[\d\s\-()+.]+$/.test(text.trim()) && text.replace(/\D/g, "").length >= 6
}

/** El número de WhatsApp, obligatorio (un número a medias ya lo dice el propio campo). */
const whatsappNumber = z
  .string()
  .nullable()
  .refine((value) => value !== null, "Escribe su número de WhatsApp.")

const phoneSchema = z.object({ phone: whatsappNumber })

/** Lo mismo que pide «Nueva persona» (`POST /api/people`), con sus topes. */
const createSchema = z.object({
  givenNames: z.string().trim().min(1, "Escribe sus nombres.").max(100, "Escribe como mucho 100 caracteres."),
  familyName: z.string().trim().min(1, "Escribe sus apellidos.").max(200, "Escribe como mucho 200 caracteres."),
  phone: whatsappNumber,
})

/** La persona que ya se creó en este diálogo: reintentar solo abre su conversación. */
interface CreatedPerson {
  id: string
  displayName: string
}

/**
 * «Nueva conversación» de la Bandeja: se busca a la persona por nombre o por
 * teléfono y se le escribe; si no existe, se crea con su número. Busca y crea
 * con lo mismo que «Nueva persona» (`/api/people`, `createPerson`): nombres y
 * apellidos separados y el mismo buscador. El WhatsApp
 * sale solo del número, sin escribir «wa:» ni elegir canales. Lo que sigue (los
 * mensajes aprobados para quien nunca escribió) lo ofrece el propio hilo.
 */
export function NewConversationDialog({
  open,
  onClose,
  initialQuery = "",
}: {
  open: boolean
  onClose: () => void
  /** Lo que ya se buscaba en la Bandeja, como punto de partida. */
  initialQuery?: string
}) {
  const navigate = useNavigate()
  const profile = useOrgProfile()
  const canCreate = usePermission("crm.write")
  const write = useWriteToPerson()
  const [query, setQuery] = useState(initialQuery)
  const [debounced, setDebounced] = useState(initialQuery)
  const [creating, setCreating] = useState(false)
  const [needsPhoneFor, setNeedsPhoneFor] = useState<PersonListItem | null>(null)
  // Si la persona ya se creó y falló abrir su conversación (el número, el WhatsApp
  // de la clínica), reintentar no crea otra: solo vuelve a abrir la conversación.
  const createdRef = useRef<CreatedPerson | null>(null)
  const [created, setCreated] = useState<CreatedPerson | null>(null)
  const searchId = useId()
  const country = normalizeCountry(profile.data?.countryCode)

  const open_ = (conversationId: string) => {
    onClose()
    void navigate({ to: "/inbox", search: { conversation: conversationId } })
  }

  const phoneForm = useAppForm({
    defaultValues: { phone: null as string | null },
    validators: { onSubmit: phoneSchema },
    onSubmit: async ({ value }) => {
      if (!needsPhoneFor || !value.phone) return
      const result = await write.mutateAsync({ contactId: needsPhoneFor.id, phone: value.phone })
      open_(result.conversationId)
    },
  })

  const createForm = useAppForm({
    defaultValues: { givenNames: "", familyName: "", phone: null as string | null },
    validators: { onSubmit: createSchema },
    onSubmit: async ({ value }) => {
      if (!value.phone) return
      let person = createdRef.current
      if (!person) {
        // La misma operación que «Nuevo contacto» (`createPerson`): nombres y apellidos, dos campos.
        const givenNames = value.givenNames.trim()
        const familyName = value.familyName.trim()
        const response = await apiFetch<{ data: { id: string } }>("/api/people", {
          method: "POST",
          body: JSON.stringify({ givenNames, familyName, phone: value.phone }),
        })
        person = { id: response.data.id, displayName: `${givenNames} ${familyName}` }
        createdRef.current = person
        setCreated(person)
      }
      // Con el número escrito: si se corrigió tras un rechazo, va el nuevo.
      const result = await write.mutateAsync({ contactId: person.id, phone: value.phone })
      open_(result.conversationId)
    },
  })

  const submitPhone = useFormSubmit(phoneForm)
  const submitCreate = useFormSubmit(createForm)
  const phoneError = useFormSubmitError(phoneForm)
  const createError = useFormSubmitError(createForm)
  const phoneSubmitting = useStore(phoneForm.store, (state) => state.isSubmitting)
  const createSubmitting = useStore(createForm.store, (state) => state.isSubmitting)

  // biome-ignore lint/correctness/useExhaustiveDependencies: se reinicia una vez por apertura
  useEffect(() => {
    if (!open) return
    setQuery(initialQuery)
    setDebounced(initialQuery)
    setCreating(false)
    setNeedsPhoneFor(null)
    createdRef.current = null
    setCreated(null)
    phoneForm.reset({ phone: null })
    createForm.reset({ givenNames: "", familyName: "", phone: null })
    write.reset()
  }, [open])

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250)
    return () => clearTimeout(timer)
  }, [query])

  const results = useQuery({
    queryKey: ["people", "nueva-conversacion", debounced],
    enabled: open && debounced.length >= 2,
    queryFn: () =>
      apiFetch<{ data: PersonListItem[] }>(`/api/people?ver=todos&limit=8&q=${encodeURIComponent(debounced)}`),
    placeholderData: keepPreviousData,
  })
  const people = debounced.length >= 2 ? (results.data?.data ?? []) : []

  const choose = (person: PersonListItem) => {
    write.mutate(
      { contactId: person.id },
      {
        onSuccess: (result) => open_(result.conversationId),
        onError: (error) => {
          if (error instanceof ApiError && error.shape.code === "NO_PHONE") {
            phoneForm.reset({ phone: null })
            setNeedsPhoneFor(person)
          }
        },
      },
    )
  }

  const startCreating = () => {
    const text = query.trim()
    if (looksLikePhone(text)) {
      createForm.reset({ givenNames: "", familyName: "", phone: toE164(text, country) })
    } else {
      // Lo buscado propone los nombres; los apellidos se escriben aparte.
      createForm.reset({ givenNames: text, familyName: "", phone: null })
    }
    write.reset()
    setCreating(true)
  }

  // Al volver a la búsqueda no queda a la vista el error del formulario que se dejó.
  const backToSearch = () => {
    write.reset()
    setNeedsPhoneFor(null)
    setCreating(false)
  }

  const busy = write.isPending || phoneSubmitting || createSubmitting
  const writeError =
    write.error && !(write.error instanceof ApiError && write.error.shape.code === "NO_PHONE") ? write.error : null
  const createLabel = looksLikePhone(query) ? `Crear persona con ${query.trim()}` : `Crear persona «${query.trim()}»`

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !busy) onClose()
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Nueva conversación</DialogTitle>
          <DialogDescription>
            Busca a la persona por su nombre o su teléfono. Si tiene teléfono, se le escribe por WhatsApp.
          </DialogDescription>
        </DialogHeader>

        {needsPhoneFor ? (
          <form className="grid gap-3" noValidate onSubmit={submitPhone}>
            <p className="text-sm">
              {needsPhoneFor.displayName} no tiene un número de WhatsApp. Escríbelo y se abre su conversación.
            </p>
            <phoneForm.AppField name="phone">
              {(field) => (
                <field.PhoneField
                  label="Su número de WhatsApp"
                  description="Queda como su WhatsApp para las próximas veces."
                  defaultCountry={country}
                />
              )}
            </phoneForm.AppField>
            {phoneError ? (
              <p role="alert" className="text-sm text-destructive">
                {phoneError}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={phoneSubmitting} onClick={backToSearch}>
                Volver
              </Button>
              <SubmitButton type="submit" pending={phoneSubmitting}>
                Escribirle
              </SubmitButton>
            </DialogFooter>
          </form>
        ) : creating ? (
          <form className="grid gap-3" noValidate onSubmit={submitCreate}>
            {created ? (
              <p className="text-sm">
                Ya se creó a {created.displayName}: corrige lo que se indica y se abre su conversación. Su nombre se
                cambia después en su ficha.
              </p>
            ) : null}
            <createForm.AppField name="givenNames">
              {(field) => <field.TextField label="Nombres" maxLength={100} autoFocus readOnly={created !== null} />}
            </createForm.AppField>
            <createForm.AppField name="familyName">
              {(field) => <field.TextField label="Apellidos" maxLength={200} readOnly={created !== null} />}
            </createForm.AppField>
            <createForm.AppField name="phone">
              {(field) => (
                <field.PhoneField
                  label="Teléfono"
                  description="Se le escribe por WhatsApp a este número."
                  defaultCountry={country}
                />
              )}
            </createForm.AppField>
            {createError ? (
              <p role="alert" className="text-sm text-destructive">
                {createError}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={createSubmitting} onClick={backToSearch}>
                Volver
              </Button>
              <SubmitButton type="submit" pending={createSubmitting}>
                {created ? "Escribirle" : "Crear y escribirle"}
              </SubmitButton>
            </DialogFooter>
          </form>
        ) : (
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <FieldLabel htmlFor={searchId} className="sr-only">
                Buscar por nombre o teléfono
              </FieldLabel>
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  id={searchId}
                  type="search"
                  autoFocus
                  className="pl-9"
                  placeholder="Buscar por nombre o teléfono"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
            </div>
            {debounced.length < 2 ? (
              <p className="text-sm text-muted-foreground">Escribe al menos dos letras o números.</p>
            ) : results.isLoading ? (
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner className="size-5" aria-hidden />
                Buscando…
              </p>
            ) : results.isError ? (
              <div className="flex flex-wrap items-center gap-2">
                <p role="alert" className="text-sm text-destructive">
                  No se pudo buscar.
                </p>
                <Button variant="outline" size="sm" onClick={() => void results.refetch()}>
                  Reintentar
                </Button>
              </div>
            ) : (
              <ul className="grid gap-2" aria-label="Personas encontradas">
                {people.length === 0 ? (
                  <li className="text-sm text-muted-foreground">Nadie coincide con «{debounced}».</li>
                ) : null}
                {people.map((person) => (
                  <li key={person.id}>
                    <Button
                      variant="outline"
                      className="h-auto min-h-11 w-full justify-between gap-2 py-2 text-left"
                      disabled={busy || person.archived}
                      onClick={() => choose(person)}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-semibold">{person.displayName}</span>
                        <span className="block truncate text-xs font-normal text-muted-foreground">
                          {[
                            person.phone ? internationalText(person.phone) : "Sin teléfono",
                            person.archived
                              ? "archivada"
                              : person.lastInteractionAt
                                ? `escribió ${timeAgo(person.lastInteractionAt)}`
                                : "nunca escribió",
                          ].join(" · ")}
                        </span>
                      </span>
                      {write.isPending && write.variables?.contactId === person.id ? (
                        <Spinner className="size-5 shrink-0" aria-hidden />
                      ) : (
                        <span className="flex shrink-0 items-center gap-1 text-sm font-semibold text-primary">
                          Elegir
                          <ChevronRight className="size-4" aria-hidden />
                        </span>
                      )}
                    </Button>
                  </li>
                ))}
                {canCreate ? (
                  <li>
                    <Button
                      variant="ghost"
                      className="h-auto min-h-11 w-full justify-start gap-2 py-2 text-left"
                      disabled={busy}
                      onClick={startCreating}
                    >
                      <UserPlus className="size-4 shrink-0" aria-hidden />
                      <span className="min-w-0">
                        <span className="block truncate font-semibold">{createLabel}</span>
                        <span className="block truncate text-xs font-normal text-muted-foreground">
                          Se le escribe por WhatsApp
                        </span>
                      </span>
                    </Button>
                  </li>
                ) : null}
              </ul>
            )}
            {writeError ? (
              <p role="alert" className="text-sm text-destructive">
                {submitErrorMessage(writeError)}
              </p>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
