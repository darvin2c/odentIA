import { Badge, Button, Field, FieldDescription, FieldLabel, Input, Textarea } from "@odentia/ui"
import {
  ConfirmDialog,
  FormDrawer,
  normalizeCountry,
  PhoneInput,
  SkeletonRegion,
} from "@odentia/ui-patterns"
import { ChannelRowsSkeleton } from "../skeletons/person-sections"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { channelIcon, channelLabel, identityText } from "../../lib/channels"
import { type ContactFull, timeAgo, usePermission } from "../../lib/crm"
import { useOrgProfile } from "../../lib/org"
import type { PersonPage } from "../../lib/people"
import { mutationErrorMessage, QueryErrorState } from "../../lib/query-error"
import { SummaryCard } from "../patient/resumen-tab"
import { PersonPicker, type PickedPerson } from "../person-picker"
import { ChoiceSelect } from "../ui/choice-select"

type Identity = ContactFull["identities"][number]

function codeOf(error: unknown): string | null {
  return error instanceof ApiError ? (error.shape.code ?? null) : null
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
  const [channel, setChannel] = useState("whatsapp")
  const [phone, setPhone] = useState<string | null>(null)
  const [accountId, setAccountId] = useState("")
  const [moving, setMoving] = useState<Identity | null>(null)
  const [destination, setDestination] = useState<PickedPerson | null>(null)
  const [reason, setReason] = useState("")
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
  const add = useMutation({
    mutationFn: () =>
      apiFetch(`/api/contacts/${person.id}/identities`, {
        method: "POST",
        body: JSON.stringify({
          channel,
          externalUserId: channel === "whatsapp" ? (phone ?? "") : accountId.trim(),
        }),
      }),
    onSuccess: () => {
      setAdding(false)
      setPhone(null)
      setAccountId("")
      refresh()
    },
  })
  const move = useMutation({
    mutationFn: () =>
      apiFetch<{ data: { movedConversations: number; movedTasks: number } }>(
        `/api/contacts/${person.id}/identities/${moving?.id ?? ""}/move`,
        {
          method: "POST",
          body: JSON.stringify({ toContactId: destination?.id, reason: reason.trim() }),
        },
      ),
    onSuccess: (result) => {
      setMoved(
        `Se pasó la cuenta a ${destination?.name ?? "la otra persona"} con ${result.data.movedConversations} conversación(es). Sus oportunidades y vínculos se quedan aquí.`,
      )
      setMoving(null)
      setDestination(null)
      setReason("")
      refresh()
    },
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
  const ambiguous = codeOf(move.error) === "AMBIGUOUS_CHANNEL_HISTORY"

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
              add.reset()
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
                      move.reset()
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
        open={adding}
        onClose={() => {
          if (!add.isPending) setAdding(false)
        }}
        title="Agregar canal"
        description="La cuenta por la que esta persona escribe o recibirá mensajes."
        submitLabel="Agregar"
        isSubmitting={add.isPending}
        submitDisabled={channel === "whatsapp" ? !phone : !accountId.trim()}
        error={
          codeOf(add.error) === "IDENTITY_IN_USE" ||
          (add.error instanceof ApiError && add.error.status === 409)
            ? "Esa cuenta ya es de otra persona. Si cambió de dueño, pásala desde la página de esa persona."
            : add.error
              ? mutationErrorMessage(add.error)
              : null
        }
        onSubmit={(event) => {
          event.preventDefault()
          add.mutate()
        }}
      >
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="person-channel">Canal</FieldLabel>
            <ChoiceSelect
              id="person-channel"
              value={channel}
              onChange={(event) => setChannel(event.target.value)}
            >
              <option value="whatsapp">WhatsApp</option>
              <option value="telegram">Telegram</option>
            </ChoiceSelect>
          </Field>
          {channel === "whatsapp" ? (
            <Field>
              <FieldLabel htmlFor="person-channel-phone">Su número de WhatsApp</FieldLabel>
              <PhoneInput
                id="person-channel-phone"
                value={phone}
                defaultCountry={countryCode}
                onChange={setPhone}
              />
            </Field>
          ) : (
            <Field>
              <FieldLabel htmlFor="person-channel-account">Número de cuenta de Telegram</FieldLabel>
              <Input
                id="person-channel-account"
                inputMode="numeric"
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
              />
              <FieldDescription>
                Es el número que Telegram le da a la persona, no su @usuario.
              </FieldDescription>
            </Field>
          )}
        </div>
      </FormDrawer>

      <FormDrawer
        dock={false}
        open={moving !== null}
        onClose={() => {
          if (!move.isPending) {
            setMoving(null)
            move.reset()
          }
        }}
        title="Pasar el canal a otra persona"
        description={
          moving
            ? `La cuenta ${channelLabel(moving.channel)} ${identityText(moving)} y sus conversaciones pasan a la persona que elijas. Sus oportunidades, seguimientos y vínculos con pacientes se quedan con ${person.displayName}.`
            : undefined
        }
        submitLabel="Pasar"
        isSubmitting={move.isPending}
        submitDisabled={!destination || !reason.trim()}
        error={
          ambiguous
            ? "Hay conversaciones de este canal sin cuenta asignada: asígnalas primero. No se mueve nada por suposición."
            : move.error
              ? mutationErrorMessage(move.error)
              : null
        }
        onSubmit={(event) => {
          event.preventDefault()
          if (destination && reason.trim()) move.mutate()
        }}
      >
        <div className="flex flex-col gap-4">
          <PersonPicker
            label="A quién pasa"
            value={destination}
            onChange={setDestination}
            excludeId={person.id}
            includeArchived
          />
          <Field>
            <FieldLabel htmlFor="person-channel-reason">Por qué</FieldLabel>
            <Textarea
              id="person-channel-reason"
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              placeholder="La persona contó que este número ahora lo usa…"
            />
          </Field>
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
        description={
          assign.error
            ? (mutationErrorMessage(assign.error) ?? "No se pudo asignar.")
            : `La conversación queda unida a ${assigning ? identityText(assigning.identity) : ""}. Los grupos de Telegram nunca se asignan a una persona.`
        }
        confirmLabel="Asignar"
        variant="default"
        pending={assign.isPending}
      />
    </SummaryCard>
  )
}
