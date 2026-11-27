import {
  Badge,
  Button,
  cn,
  FieldGroup,
  Popover,
  PopoverContent,
  PopoverTrigger,
  toast,
} from "@odentia/ui"
import {
  AgentMark,
  DetailField,
  DetailList,
  SubmitButton,
  submitErrorMessage,
  useAppForm,
  useFormSubmit,
  useFormSubmitError,
} from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { History, Lock, Pencil, UserRoundCheck, UserRoundX } from "lucide-react"
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react"
import { z } from "zod"
import { api } from "./lib/api"
import { CUSTOMER_KEY, type CustomerDetail } from "./lib/clientes"
import {
  alternativeValue,
  birthdayParts,
  birthdayProblem,
  birthdayValue,
  type ConsentNote,
  type CustomerFactKey,
  type CustomerProfile,
  channelsWhere,
  consentBadge,
  consentNoteText,
  consentOrigin,
  FACT_COLUMNS,
  factOrigin,
  MONTHS,
  PROFILE_CHANNELS,
  type ProfileFact,
  stepText,
} from "./lib/perfil"
import { useStoreContext } from "./tiendas"

/**
 * El perfil de la clienta en su ficha (ADR 0240): «Lo que Argos sabe de ella», cada dato con su
 * fuente y su historial, y «Cuándo se le puede escribir». Argos lo anota solo; lo que corrige una
 * persona queda suyo y Argos no lo vuelve a pisar. Soporte lo mira sin «Corregir» (`canCorrect`).
 */

/** «Lo hizo Argos»: la marca del agente junto a lo que anotó. */
function DeArgos({ children }: { children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-start gap-1.5 text-xs text-muted-foreground">
      <AgentMark size="sm" className="shrink-0" />
      <span className="min-w-0 break-words pt-0.5">{children}</span>
    </span>
  )
}

/** Una tarjeta dentro de la ficha, con su título y, si hace falta, la frase que la explica. */
function ProfileCard({
  title,
  subtitle,
  className,
  children,
}: {
  title: string
  subtitle?: string
  className?: string
  children: ReactNode
}) {
  const id = useId()
  return (
    <section
      aria-labelledby={id}
      className={cn("flex min-w-0 flex-col gap-3 rounded-lg border p-4", className)}
    >
      <div className="flex flex-col gap-0.5">
        <h3 id={id} className="text-base font-semibold">
          {title}
        </h3>
        {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
      </div>
      {children}
    </section>
  )
}

/** Guardar un dato corregido: la respuesta trae el perfil entero, y la ficha lo toma. */
function useCorrectFact(customer: CustomerDetail) {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { key: CustomerFactKey; value: string }) =>
      api<{ profile: CustomerProfile }>(`/api/tiendas/${store.id}/clientes/${customer.id}/datos`, {
        method: "POST",
        body,
      }),
    onSuccess: ({ profile }) => {
      queryClient.setQueriesData<CustomerDetail>({ queryKey: CUSTOMER_KEY(store.id) }, (old) =>
        old && old.id === customer.id ? { ...old, profile } : old,
      )
      toast.success("Guardado. Argos no lo vuelve a cambiar.")
    },
  })
}

/* ------------------------------------------------------------ lo que Argos sabe */

export function ArgosKnows({
  customer,
  profile,
}: {
  customer: CustomerDetail
  profile: CustomerProfile
}) {
  return (
    <ProfileCard
      title="Lo que Argos sabe de ella"
      subtitle="Lo anota solo, de sus chats y sus pedidos. Si corriges algo, queda tuyo."
      className="@container"
    >
      <div className="grid gap-x-8 @xl:grid-cols-2">
        {FACT_COLUMNS.map((column, index) => (
          <div
            key={column[0]?.key}
            className={cn("flex min-w-0 flex-col", index > 0 && "border-t @xl:border-t-0")}
          >
            {column.map((row) => (
              <FactRow
                key={row.key}
                customer={customer}
                factKey={row.key}
                label={row.label ?? profile.measureLabel}
                fact={profile.facts[row.key]}
                empty={row.empty}
                canCorrect={profile.canCorrect}
              />
            ))}
          </div>
        ))}
      </div>
    </ProfileCard>
  )
}

function FactRow({
  customer,
  factKey,
  label,
  fact,
  empty,
  canCorrect,
}: {
  customer: CustomerDetail
  factKey: CustomerFactKey
  label: string
  fact: ProfileFact | undefined
  empty: string
  canCorrect: boolean
}) {
  const { store } = useStoreContext()
  const [editing, setEditing] = useState(false)
  const correctButton = useRef<HTMLButtonElement>(null)
  const pick = useCorrectFact(customer)
  // Al cerrar «Corregir» (guardado, «Cancelar» o Esc) el foco vuelve a su botón.
  const returnFocus = useRef(false)
  useEffect(() => {
    if (!editing && returnFocus.current) {
      returnFocus.current = false
      correctButton.current?.focus()
    }
  }, [editing])
  const close = () => {
    returnFocus.current = true
    setEditing(false)
  }
  const origin = fact ? factOrigin(fact, store.timeZone) : null
  const lower = label.toLowerCase()

  return (
    <div className="flex min-w-0 flex-col gap-1.5 border-t py-3 first:border-t-0">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {fact && fact.alternatives.length > 0 ? (
          <Badge variant="warning">Por confirmar</Badge>
        ) : null}
        {origin?.byStore ? (
          <Badge variant="secondary" className="gap-1">
            <Lock className="size-3" aria-hidden />
            Lo puso la tienda
          </Badge>
        ) : null}
        <span className="ml-auto flex items-center gap-0.5">
          {fact && fact.history.length > 0 ? (
            <Popover>
              <PopoverTrigger
                render={
                  <Button variant="ghost" size="icon-sm" aria-label={`Historial de ${lower}`} />
                }
              >
                <History aria-hidden />
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] gap-2">
                <p className="text-sm font-semibold">{label}: historial</p>
                <ol className="flex flex-col gap-2">
                  {fact.history.map((step) => (
                    <li
                      key={`${step.at}-${step.value}`}
                      className="flex flex-col border-t pt-2 text-sm first:border-t-0 first:pt-0"
                    >
                      <span className="font-medium break-words">{step.value}</span>
                      <span className="text-xs break-words text-muted-foreground">
                        {stepText(step, store.timeZone)}
                      </span>
                    </li>
                  ))}
                </ol>
              </PopoverContent>
            </Popover>
          ) : null}
          {canCorrect && !editing ? (
            <Button
              ref={correctButton}
              variant="ghost"
              size="xs"
              aria-label={`Corregir ${lower}`}
              onClick={() => setEditing(true)}
            >
              <Pencil aria-hidden />
              Corregir
            </Button>
          ) : null}
        </span>
      </div>
      {editing ? (
        <FactEditor
          customer={customer}
          factKey={factKey}
          label={label}
          fact={fact}
          onClose={close}
        />
      ) : fact ? (
        <>
          <span className="font-medium break-words">{fact.value}</span>
          {origin?.byStore ? (
            <span className="text-xs text-muted-foreground">{origin.text}</span>
          ) : origin ? (
            <DeArgos>{origin.text}</DeArgos>
          ) : null}
          {fact.alternatives.length > 0 ? (
            <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              Usa {fact.value} mientras tanto. ¿Cuál es?
              {canCorrect
                ? fact.alternatives.map((option) => (
                    <SubmitButton
                      key={option}
                      size="xs"
                      variant="outline"
                      pending={
                        pick.isPending &&
                        pick.variables?.value === alternativeValue(factKey, option)
                      }
                      disabled={pick.isPending}
                      onClick={() =>
                        pick.mutate(
                          { key: factKey, value: alternativeValue(factKey, option) },
                          // Los botones se van con la duda: el foco queda en «Corregir».
                          { onSuccess: () => correctButton.current?.focus() },
                        )
                      }
                    >
                      {option}
                    </SubmitButton>
                  ))
                : fact.alternatives.join(" · ")}
            </span>
          ) : null}
          {pick.isError ? (
            <p role="alert" className="text-xs text-danger">
              {submitErrorMessage(pick.error)}
            </p>
          ) : null}
        </>
      ) : (
        <span className="text-sm text-muted-foreground">{empty}</span>
      )}
    </div>
  )
}

/**
 * «Corregir» en línea: el campo con su error, Guardar y Cancelar. Esc cancela. Cumpleaños es día
 * y mes, sin año (`--MM-DD`); el canal, uno de los chats.
 */
function FactEditor({
  customer,
  factKey,
  label,
  fact,
  onClose,
}: {
  customer: CustomerDetail
  factKey: CustomerFactKey
  label: string
  fact: ProfileFact | undefined
  onClose: () => void
}) {
  const save = useCorrectFact(customer)
  const root = useRef<HTMLFormElement>(null)
  const raw = fact?.raw ?? ""
  const birthday = birthdayParts(raw)
  const form = useAppForm({
    defaultValues: { value: raw, day: birthday.day, month: birthday.month },
    validators: {
      onSubmit: z
        .object({ value: z.string(), day: z.string(), month: z.string() })
        .superRefine((value, ctx) => {
          if (factKey === "cumpleanos") {
            const problem = birthdayProblem(value.day, value.month)
            if (problem)
              ctx.addIssue({
                code: "custom",
                message: problem,
                path: [value.day ? "month" : "day"],
              })
          } else if (!value.value.trim())
            ctx.addIssue({
              code: "custom",
              message: factKey === "canal" ? "Elige el canal." : "Escribe cómo es.",
              path: ["value"],
            })
        }),
    },
    onSubmit: async ({ value }) => {
      await save.mutateAsync({
        key: factKey,
        value:
          factKey === "cumpleanos" ? birthdayValue(value.day, value.month) : value.value.trim(),
      })
      onClose()
    },
  })
  // Lo que el servidor diga del valor, en el campo que se ve.
  const onSubmit = useFormSubmit(form, {
    fieldMap: factKey === "cumpleanos" ? { value: "day" } : undefined,
  })
  const formError = useFormSubmitError(form)
  // Al abrir, el foco va al campo.
  useEffect(() => {
    const scope = root.current
    const control =
      scope?.querySelector<HTMLElement>("[role='combobox']") ??
      scope?.querySelector<HTMLElement>("input:not([type='hidden']):not([aria-hidden='true'])")
    control?.focus()
  }, [])
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    // Esc de una lista abierta (en su propia capa) la cierra a ella, no a «Corregir».
    if (event.key !== "Escape" || !event.currentTarget.contains(event.target as Node)) return
    event.preventDefault()
    onClose()
  }

  return (
    <form
      ref={root}
      noValidate
      onSubmit={onSubmit}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-2"
    >
      <FieldGroup className="gap-3">
        {factKey === "cumpleanos" ? (
          <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2">
            <form.AppField name="day">
              {(field) => (
                <field.SelectField
                  label="Día"
                  placeholder="Día"
                  options={Array.from({ length: 31 }, (_, i) => ({
                    value: String(i + 1),
                    label: String(i + 1),
                  }))}
                />
              )}
            </form.AppField>
            <form.AppField name="month">
              {(field) => (
                <field.SelectField
                  label="Mes"
                  placeholder="Mes"
                  options={MONTHS.map((name, i) => ({ value: String(i + 1), label: name }))}
                />
              )}
            </form.AppField>
          </div>
        ) : factKey === "canal" ? (
          <form.AppField name="value">
            {(field) => (
              <field.SelectField
                label={label}
                hideLabel
                placeholder="Elige el canal"
                options={Object.entries(PROFILE_CHANNELS).map(([value, name]) => ({
                  value,
                  label: name,
                }))}
              />
            )}
          </form.AppField>
        ) : (
          <form.AppField name="value">
            {(field) => (
              <field.TextField
                label={label}
                hideLabel
                maxLength={120}
                placeholder={factKey === "instagram" ? "@usuario" : undefined}
              />
            )}
          </form.AppField>
        )}
      </FieldGroup>
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton type="submit" size="sm" pending={save.isPending}>
          Guardar
        </SubmitButton>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancelar
        </Button>
      </div>
      {formError ? (
        <p role="alert" className="text-sm text-danger">
          {formError}
        </p>
      ) : null}
    </form>
  )
}

/* ------------------------------------------------------ cuándo se le puede escribir */

export function WhenToWrite({ profile }: { profile: CustomerProfile }) {
  const { store } = useStoreContext()
  const badge = consentBadge(profile.consent.state)
  const origin = consentOrigin(profile.consent, store.timeZone)
  return (
    <ProfileCard title="Cuándo se le puede escribir">
      <DetailList columns={1}>
        <DetailField label="Promociones">
          <span className="flex flex-col items-start gap-1">
            <Badge variant={badge.variant}>{badge.label}</Badge>
            {origin ? (
              <span className="text-xs break-words text-muted-foreground">{origin}</span>
            ) : null}
          </span>
        </DetailField>
        <DetailField label="Por dónde">{channelsWhere(profile.channels)}</DetailField>
      </DetailList>
    </ProfileCard>
  )
}

/* ------------------------------------------------------------- la nota en el chat */

/** En el hilo: Sofi anotó el permiso o la baja en su ficha. */
export function ConsentNoteLine({ note }: { note: ConsentNote }) {
  const { store } = useStoreContext()
  const Icon = note.state === "si" ? UserRoundCheck : UserRoundX
  return (
    <p
      className={cn(
        "flex max-w-[92%] items-center gap-2 self-center rounded-2xl px-3 py-1.5 text-center text-xs font-medium",
        note.state === "si"
          ? "bg-success-soft text-success"
          : note.state === "baja"
            ? "bg-danger-soft text-destructive"
            : "bg-surface-muted text-muted-foreground",
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span>{consentNoteText(note, store.timeZone)}</span>
    </p>
  )
}
