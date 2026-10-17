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
import { internationalText, normalizeCountry, PhoneInput, SubmitButton, toE164 } from "@odentia/ui-patterns"
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { ChevronRight, Search, UserPlus } from "lucide-react"
import { useEffect, useId, useState } from "react"
import { ApiError, apiFetch } from "../lib/api"
import { timeAgo, usePermission } from "../lib/crm"
import type { PersonListItem } from "../lib/people"
import { useOrgProfile } from "../lib/org"
import { useWriteToPerson } from "./write-to-person"

/** ¿Lo que se escribió parece un teléfono? (dígitos, espacios, guiones, paréntesis o «+»). */
function looksLikePhone(text: string): boolean {
  return /^[\d\s\-()+.]+$/.test(text.trim()) && text.replace(/\D/g, "").length >= 6
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? (error.shape.message ?? fallback) : fallback
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
  const [name, setName] = useState({ givenNames: "", paternalSurname: "", maternalSurname: "" })
  const [phone, setPhone] = useState<string | null>(null)
  const [needsPhoneFor, setNeedsPhoneFor] = useState<PersonListItem | null>(null)
  const searchId = useId()
  const nameId = useId()
  const paternalId = useId()
  const maternalId = useId()
  const phoneId = useId()
  const country = normalizeCountry(profile.data?.countryCode)

  // biome-ignore lint/correctness/useExhaustiveDependencies: se reinicia una vez por apertura
  useEffect(() => {
    if (!open) return
    setQuery(initialQuery)
    setDebounced(initialQuery)
    setCreating(false)
    setName({ givenNames: "", paternalSurname: "", maternalSurname: "" })
    setPhone(null)
    setNeedsPhoneFor(null)
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

  const open_ = (conversationId: string) => {
    onClose()
    void navigate({ to: "/inbox", search: { conversation: conversationId } })
  }

  const choose = (person: PersonListItem, typed?: string) => {
    write.mutate(
      { contactId: person.id, ...(typed ? { phone: typed } : {}) },
      {
        onSuccess: (result) => open_(result.conversationId),
        onError: (error) => {
          if (error instanceof ApiError && error.shape.code === "NO_PHONE") setNeedsPhoneFor(person)
        },
      },
    )
  }

  const create = useMutation({
    retry: false,
    mutationFn: async () => {
      // La misma operación que «Nueva persona» (`createPerson`): nombres y apellidos separados.
      const created = await apiFetch<{ data: { id: string } }>("/api/people", {
        method: "POST",
        body: JSON.stringify({
          givenNames: name.givenNames.trim() || null,
          paternalSurname: name.paternalSurname.trim() || null,
          maternalSurname: name.maternalSurname.trim() || null,
          ...(phone ? { phone } : {}),
        }),
      })
      return write.mutateAsync({ contactId: created.data.id })
    },
    onSuccess: (result) => open_(result.conversationId),
  })

  const startCreating = () => {
    const text = query.trim()
    if (looksLikePhone(text)) {
      setPhone(toE164(text, country))
      setName({ givenNames: "", paternalSurname: "", maternalSurname: "" })
    } else {
      // Lo buscado propone los nombres; los apellidos se escriben aparte.
      setName({ givenNames: text, paternalSurname: "", maternalSurname: "" })
      setPhone(null)
    }
    setCreating(true)
  }

  const busy = write.isPending || create.isPending
  const writeError = write.error && !(write.error instanceof ApiError && write.error.shape.code === "NO_PHONE") ? write.error : null
  const createLabel = looksLikePhone(query) ? `Crear persona con ${query.trim()}` : `Crear persona «${query.trim()}»`
  const nameReady = Boolean(name.givenNames.trim() && (name.paternalSurname.trim() || name.maternalSurname.trim()))

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
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (phone) choose(needsPhoneFor, phone)
            }}
          >
            <p className="text-sm">
              {needsPhoneFor.displayName} no tiene un número de WhatsApp. Escríbelo y se abre su conversación.
            </p>
            <div className="grid gap-1.5">
              <FieldLabel htmlFor={phoneId}>Su número de WhatsApp</FieldLabel>
              <PhoneInput id={phoneId} value={phone} defaultCountry={country} onChange={setPhone} />
              <p className="text-xs text-muted-foreground">Queda como su WhatsApp para las próximas veces.</p>
            </div>
            {writeError ? (
              <p role="alert" className="text-sm text-destructive">
                {errorText(writeError, "No se pudo abrir la conversación.")}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setNeedsPhoneFor(null)}>
                Volver
              </Button>
              <SubmitButton type="submit" disabled={!phone} pending={write.isPending}>
                Escribirle
              </SubmitButton>
            </DialogFooter>
          </form>
        ) : creating ? (
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (nameReady) create.mutate()
            }}
          >
            <div className="grid gap-1.5">
              <FieldLabel htmlFor={nameId}>Nombres</FieldLabel>
              <Input
                id={nameId}
                value={name.givenNames}
                maxLength={100}
                autoFocus
                onChange={(event) => setName({ ...name, givenNames: event.target.value })}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <FieldLabel htmlFor={paternalId}>Primer apellido</FieldLabel>
                <Input
                  id={paternalId}
                  value={name.paternalSurname}
                  maxLength={100}
                  onChange={(event) => setName({ ...name, paternalSurname: event.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <FieldLabel htmlFor={maternalId}>Segundo apellido</FieldLabel>
                <Input
                  id={maternalId}
                  value={name.maternalSurname}
                  maxLength={100}
                  onChange={(event) => setName({ ...name, maternalSurname: event.target.value })}
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <FieldLabel htmlFor={phoneId}>Teléfono</FieldLabel>
              <PhoneInput id={phoneId} value={phone} defaultCountry={country} onChange={setPhone} />
              <p className="text-xs text-muted-foreground">Se le escribe por WhatsApp a este número.</p>
            </div>
            {create.error ? (
              <p role="alert" className="text-sm text-destructive">
                {errorText(create.error, "No se pudo crear a la persona.")}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreating(false)}>
                Volver
              </Button>
              <SubmitButton type="submit" disabled={!nameReady || !phone} pending={create.isPending}>
                Crear y escribirle
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
                {errorText(writeError, "No se pudo abrir la conversación.")}
              </p>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
