import { Badge, Button } from "@odentia/ui"
import {
  ConfirmDialog,
  FormDrawer,
  normalizeCountry,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
  SkeletonRegion,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { z } from "zod"
import { ApiError, apiFetch } from "../../lib/api"
import { channelIcon, channelLabel, identityText } from "../../lib/channels"
import { type ContactFull, timeAgo, usePermission } from "../../lib/crm"
import { useOrgProfile } from "../../lib/org"
import type { PersonPage } from "../../lib/people"
import { QueryErrorState } from "../../lib/query-error"
import { SummaryCard } from "../patient/resumen-tab"
import { PersonPicker, type PickedPerson } from "../person-picker"
import { ChannelRowsSkeleton } from "../skeletons/person-sections"

type Identity = ContactFull["identities"][number]

const CHANNEL_OPTIONS = [
  { value: "whatsapp", label: "WhatsApp" },
  { value: "telegram", label: "Telegram" },
]

const ADD_DEFAULTS = { channel: "whatsapp", phone: null as string | null, accountId: "" }
/** Lo que exige `normalizeChannelIdentity`, dicho en el campo antes de enviar. */
const addSchema = z
  .object({ channel: z.enum(["whatsapp", "telegram"]), phone: z.string().nullable(), accountId: z.string().max(100) })
  .superRefine((value, ctx) => {
    if (value.channel === "whatsapp") {
      if (!value.phone) ctx.addIssue({ code: "custom", path: ["phone"], message: "Escribe su número de WhatsApp" })
      return
    }
    const account = value.accountId.trim().replace(/^tg:/i, "")
    if (!account)
      ctx.addIssue({ code: "custom", path: ["accountId"], message: "Escribe su número de cuenta de Telegram" })
    else if (!/^\d+$/.test(account))
      ctx.addIssue({
        code: "custom",
        path: ["accountId"],
        message: "Telegram exige el ID numérico de la plataforma (no @usuario)",
      })
  })

const MOVE_DEFAULTS = { destination: null as PickedPerson | null, reason: "" }
const moveSchema = z.object({
  destination: z.custom<PickedPerson | null>((value) => value !== null, "Elige a quién pasa la cuenta"),
  reason: z.string().trim().min(1, "Escribe por qué pasa la cuenta").max(500),
})

/** El historial sin cuenta asignada no es de un campo: se dice con el paso que lo resuelve. */
function moveFormMessage(error: unknown): string | null {
  return error instanceof ApiError && error.shape.code === "AMBIGUOUS_CHANNEL_HISTORY"
    ? "Hay conversaciones de este canal sin cuenta asignada: asígnalas primero. No se mueve nada por suposición."
    : null
}

/**
 * Canales de la persona (Datos › Canales): las cuentas por las que escribe,
 * agregar una, pasarla a otra persona y asignar una conversación que no sabe
 * de qué cuenta vino. Lo ve quien lleva el CRM y lo cambia quien atiende
 * conversaciones (la misma regla que el servidor). Un teléfono guardado no es
 * un canal hasta que alguien le escribe o lo agrega aquí.
 */
export function PersonChannels({ person }: { person: PersonPage }) {
  const canRead = usePermission("crm.read")
  const canChange = usePermission("conversations.write")
  const queryClient = useQueryClient()
  const profile = useOrgProfile()
  const countryCode = normalizeCountry(profile.data?.countryCode)
  const [adding, setAdding] = useState(false)
  const [moving, setMoving] = useState<Identity | null>(null)
  const [moved, setMoved] = useState<string | null>(null)
  const [assigning, setAssigning] = useState<{ conversationId: string; identity: Identity } | null>(
    null,
  )

  const contact = useQuery({
    queryKey: ["contact", person.id],
    queryFn: () => apiFetch<{ data: ContactFull }>(`/api/contacts/${person.id}`),
    enabled: canRead,
    retry: false,
  })
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["contact", person.id] })
    void queryClient.invalidateQueries({ queryKey: ["person", person.id] })
    void queryClient.invalidateQueries({ queryKey: ["person-conversations", person.id] })
  }
  const addForm = useAppForm({
    defaultValues: ADD_DEFAULTS,
    validators: { onSubmit: addSchema },
    onSubmit: async ({ value }) => {
      await apiFetch(`/api/contacts/${person.id}/identities`, {
        method: "POST",
        body: JSON.stringify({
          channel: value.channel,
          externalUserId: value.channel === "whatsapp" ? (value.phone ?? "") : value.accountId.trim(),
        }),
      })
      setAdding(false)
      refresh()
    },
  })
  const addChannel = useStore(addForm.store, (state) => state.values.channel)
  // El servidor nombra la cuenta `externalUserId`: aquí es el número de WhatsApp o la cuenta de Telegram.
  const addSurface = useFormSurface(addForm, {
    fieldMap: (key) => (key === "externalUserId" ? (addChannel === "whatsapp" ? "phone" : "accountId") : undefined),
  })
  const moveForm = useAppForm({
    defaultValues: MOVE_DEFAULTS,
    validators: { onSubmit: moveSchema },
    onSubmit: async ({ value }) => {
      const result = await apiFetch<{ data: { movedConversations: number; movedTasks: number } }>(
        `/api/contacts/${person.id}/identities/${moving?.id ?? ""}/move`,
        {
          method: "POST",
          body: JSON.stringify({ toContactId: value.destination?.id, reason: value.reason.trim() }),
        },
      )
      setMoved(
        `Se pasó la cuenta a ${value.destination?.name ?? "la otra persona"} con ${result.data.movedConversations} conversación(es). Sus oportunidades y vínculos se quedan aquí.`,
      )
      setMoving(null)
      refresh()
    },
  })
  const moveSurface = useFormSurface(moveForm, {
    fieldMap: { toContactId: "destination" },
    formMessage: moveFormMessage,
  })
  const assign = useMutation({
    mutationFn: (input: { conversationId: string; identityId: string }) =>
      apiFetch(`/api/conversations/${input.conversationId}/identity`, {
        method: "PUT",
        body: JSON.stringify({ identityId: input.identityId }),
      }),
    onSuccess: () => {
      setAssigning(null)
      refresh()
    },
  })

  if (!canRead) return null
  const data = contact.data?.data
  const identities = data?.identities ?? []
  const unassigned = (data?.conversations ?? []).filter(
    (conversation) =>
      conversation.contactIdentityId === null &&
      identities.some((identity) => identity.channel === conversation.channel),
  )

  return (
    <SummaryCard
      title="Canales"
      action={
        canChange && !person.archived ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              addForm.reset()
              setAdding(true)
            }}
          >
            Agregar canal
          </Button>
        ) : undefined
      }
    >
      {moved ? (
        <p role="status" className="rounded-md border p-2 text-sm">
          {moved}
        </p>
      ) : null}
      {contact.isPending ? (
        <SkeletonRegion message="Cargando…">
          <ChannelRowsSkeleton />
        </SkeletonRegion>
      ) : contact.isError ? (
        <QueryErrorState error={contact.error} onRetry={() => void contact.refetch()} />
      ) : identities.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Todavía no escribe por ningún canal. Su teléfono pasa a ser su WhatsApp cuando alguien del
          equipo le escribe con «Escribirle» o lo agrega aquí.
        </p>
      ) : (
        <ul className="flex flex-col divide-y">
          {identities.map((identity) => {
            const Icon = channelIcon(identity.channel)
            const count = (data?.conversations ?? []).filter(
              (c) => c.contactIdentityId === identity.id,
            ).length
            return (
              <li
                key={identity.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <span className="flex min-w-0 items-center gap-2 text-sm">
                  <Icon aria-hidden className="size-4" />
                  <span className="font-medium">{channelLabel(identity.channel)}</span>
                  <span className="text-muted-foreground">{identityText(identity)}</span>
                  <Badge variant="secondary">
                    {count === 1 ? "1 conversación" : `${count} conversaciones`}
                  </Badge>
                </span>
                {canChange && !person.archived ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      moveForm.reset()
                      setMoved(null)
                      setMoving(identity)
                    }}
                  >
                    Pasar a otra persona
                  </Button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      {canChange && unassigned.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-md border border-warning/30 p-3 text-sm">
          <p>
            {unassigned.length === 1
              ? "Hay una conversación que no sabe de qué cuenta vino."
              : `Hay ${unassigned.length} conversaciones que no saben de qué cuenta vinieron.`}{" "}
            Asígnala a su cuenta antes de pasar esa cuenta a otra persona.
          </p>
          <ul className="flex flex-col gap-1">
            {unassigned.map((conversation) => (
              <li key={conversation.id} className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">
                  {channelLabel(conversation.channel)} · {timeAgo(conversation.lastMessageAt)}
                </span>
                {identities
                  .filter((identity) => identity.channel === conversation.channel)
                  .map((identity) => (
                    <Button
                      key={identity.id}
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        assign.reset()
                        setAssigning({ conversationId: conversation.id, identity })
                      }}
                    >
                      Es de {identityText(identity)}
                    </Button>
                  ))}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <FormDrawer
        {...addSurface}
        open={adding}
        onClose={() => {
          if (!addSurface.isSubmitting) setAdding(false)
        }}
        title="Agregar canal"
        description="La cuenta por la que esta persona escribe o recibirá mensajes."
        submitLabel="Agregar"
      >
        <div className="flex flex-col gap-4">
          <addForm.AppField name="channel">
            {(field) => <field.SelectField label="Canal" options={CHANNEL_OPTIONS} />}
          </addForm.AppField>
          {addChannel === "whatsapp" ? (
            <addForm.AppField name="phone">
              {(field) => <field.PhoneField label="Su número de WhatsApp" defaultCountry={countryCode} />}
            </addForm.AppField>
          ) : (
            <addForm.AppField name="accountId">
              {(field) => (
                <field.TextField
                  label="Número de cuenta de Telegram"
                  description="Es el número que Telegram le da a la persona, no su @usuario."
                  inputMode="numeric"
                  maxLength={100}
                />
              )}
            </addForm.AppField>
          )}
        </div>
      </FormDrawer>

      <FormDrawer
        {...moveSurface}
        dock={false}
        open={moving !== null}
        onClose={() => {
          if (!moveSurface.isSubmitting) setMoving(null)
        }}
        title="Pasar el canal a otra persona"
        description={
          moving
            ? `La cuenta ${channelLabel(moving.channel)} ${identityText(moving)} y sus conversaciones pasan a la persona que elijas. Sus oportunidades, seguimientos y vínculos con pacientes se quedan con ${person.displayName}.`
            : undefined
        }
        submitLabel="Pasar"
      >
        <div className="flex flex-col gap-4">
          <moveForm.AppField name="destination">
            {(field) => (
              <field.Control label="A quién pasa">
                {(control) => (
                  <PersonPicker
                    id={control.id}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    label="A quién pasa"
                    value={field.state.value}
                    onChange={field.handleChange}
                    excludeId={person.id}
                    includeArchived
                  />
                )}
              </field.Control>
            )}
          </moveForm.AppField>
          <moveForm.AppField name="reason">
            {(field) => (
              <field.TextareaField
                label="Por qué"
                maxLength={500}
                placeholder="La persona contó que este número ahora lo usa…"
              />
            )}
          </moveForm.AppField>
        </div>
      </FormDrawer>

      <ConfirmDialog
        open={assigning !== null}
        onClose={() => {
          if (!assign.isPending) setAssigning(null)
        }}
        onConfirm={() =>
          assigning &&
          assign.mutate({
            conversationId: assigning.conversationId,
            identityId: assigning.identity.id,
          })
        }
        title="Asignar la conversación a su cuenta"
        description={`La conversación queda unida a ${assigning ? identityText(assigning.identity) : ""}. Los grupos de Telegram nunca se asignan a una persona.`}
        error={assign.error ? submitErrorMessage(assign.error) : null}
        confirmLabel="Asignar"
        variant="default"
        pending={assign.isPending}
      />
    </SummaryCard>
  )
}
