/**
 * Contactos de la ficha del cliente: sus personas, cada una con sus papeles
 * (decide, la usa, paga), la principal primero, y, si tiene cuenta, los
 * miembros de su equipo que aún no son una persona del cliente, como filas de
 * solo lectura (se leen de la cuenta, no se copian). Ligar una persona a su
 * usuario es de Administración y solo con el correo exactamente igual: nunca
 * por teléfono ni por un nombre parecido (lo exige el servidor).
 */
import { Badge, Button, toast } from "@odentia/ui"
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingState,
  PersonAvatar,
  RowActions,
  submitErrorMessage,
} from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Plus, UserRound } from "lucide-react"
import * as React from "react"
import { api } from "../../lib/api"
import type { ClientTabProps } from "./account-tabs"
import {
  CHANNEL_WORDS,
  type ContactRow,
  invalidateClient,
  ROLE_WORDS,
  wordOf,
} from "./client-model"
import { useClientContacts } from "./client-queries"
import { ContactDrawer } from "./contact-drawer"

const enc = encodeURIComponent

export function ClientContactsTab({ clientId, organizationId, isAdmin }: ClientTabProps) {
  const queryClient = useQueryClient()
  const contacts = useClientContacts(clientId)
  const [editing, setEditing] = React.useState<{
    contact: ContactRow | null
    initial?: { name?: string; email?: string }
  } | null>(null)
  const [linking, setLinking] = React.useState<{ contact: ContactRow; member: ContactRow } | null>(
    null,
  )

  const primary = useMutation({
    mutationFn: (contactId: string) =>
      api(`/api/admin/clients/contacts/${enc(contactId)}/primary`, { method: "POST", body: "{}" }),
    onSuccess: () => {
      invalidateClient(queryClient, clientId)
      toast.success("Ahora es la persona principal")
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
  const link = useMutation({
    mutationFn: (input: { contactId: string; userId: string }) =>
      api(`/api/admin/clients/contacts/${enc(input.contactId)}/link`, {
        method: "POST",
        body: JSON.stringify({ userId: input.userId }),
      }),
    onSuccess: () => {
      setLinking(null)
      invalidateClient(queryClient, clientId)
      toast.success("Quedó ligada a su usuario")
    },
  })

  const rows = contacts.data ?? []
  const people = rows.filter((row) => row.source === "contacto")
  const members = rows.filter((row) => row.source === "miembro")
  /** Un miembro de la cuenta con exactamente su correo: el único con quien se puede ligar. */
  const sameEmailMember = (contact: ContactRow) =>
    contact.email && !contact.user
      ? (members.find(
          (member) => member.email?.trim().toLowerCase() === contact.email?.trim().toLowerCase(),
        ) ?? null)
      : null

  return (
    <section aria-labelledby="contactos-titulo" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="contactos-titulo" className="text-base font-semibold">
          Personas
        </h2>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => setEditing({ contact: null })}
        >
          <Plus aria-hidden />
          Agregar
        </Button>
      </div>

      {contacts.isPending ? (
        <LoadingState message="Cargando sus personas…" />
      ) : contacts.isError ? (
        <ErrorState
          title="No pude cargar sus personas"
          error={contacts.error}
          onRetry={() => void contacts.refetch()}
        />
      ) : people.length === 0 && members.length === 0 ? (
        <EmptyState
          icon={UserRound}
          title="Aún no tiene personas"
          description="Agrega con quién hablamos: quién decide, quién la usa y quién paga."
          actionLabel="Agregar persona"
          onAction={() => setEditing({ contact: null })}
        />
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border bg-card">
          {people.map((contact) => {
            const member = isAdmin && organizationId ? sameEmailMember(contact) : null
            return (
              <li key={contact.id} className="flex flex-wrap items-start gap-3 p-4">
                <PersonAvatar name={contact.name} className="mt-0.5" />
                <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-semibold [overflow-wrap:anywhere]">{contact.name}</span>
                    {contact.isPrimary ? <Badge variant="secondary">Principal</Badge> : null}
                    {contact.roles.map((role) => (
                      <Badge key={role} variant="outline">
                        {wordOf(ROLE_WORDS, role, role)}
                      </Badge>
                    ))}
                    {!contact.rolesConfirmed ? (
                      <span className="text-xs text-muted-foreground">papeles por confirmar</span>
                    ) : null}
                  </div>
                  {contact.title ? (
                    <span className="text-sm text-muted-foreground">{contact.title}</span>
                  ) : null}
                  <ContactWays contact={contact} />
                  {contact.user ? (
                    <span className="text-sm text-muted-foreground">
                      Tiene cuenta{contact.user.roleLabel ? ` · ${contact.user.roleLabel}` : ""}
                    </span>
                  ) : organizationId && contact.email ? (
                    <span className="text-sm text-muted-foreground">
                      Sin ligar a un usuario de la clínica
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {member ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setLinking({ contact, member })}
                    >
                      Ligar a su usuario
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditing({ contact })}
                  >
                    Cambiar
                  </Button>
                  {!contact.isPrimary && contact.id ? (
                    <RowActions
                      label={`Más acciones para ${contact.name}`}
                      items={[
                        {
                          key: "principal",
                          label: "Hacer principal",
                          onSelect: () => contact.id && primary.mutate(contact.id),
                        },
                      ]}
                    />
                  ) : null}
                </div>
              </li>
            )
          })}
          {members.map((member) => (
            <li
              key={member.user?.userId ?? member.email}
              className="flex flex-wrap items-start gap-3 p-4"
            >
              <PersonAvatar name={member.name} className="mt-0.5" />
              <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
                <span className="font-semibold [overflow-wrap:anywhere]">{member.name}</span>
                <span className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                  Del equipo de la clínica
                  {member.user?.roleLabel ? ` · ${member.user.roleLabel}` : ""} · {member.email}
                </span>
                <span className="text-xs text-muted-foreground">
                  Se lee de su cuenta: aún no es una persona de este cliente.
                </span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  setEditing({
                    contact: null,
                    initial: { name: member.name, email: member.email ?? "" },
                  })
                }
              >
                Agregar como persona
              </Button>
            </li>
          ))}
        </ul>
      )}
      {organizationId && isAdmin ? (
        <p className="text-xs text-muted-foreground">
          Una persona se liga a su usuario solo si su correo es exactamente el de su cuenta. Nunca
          por el celular.
        </p>
      ) : null}

      <ContactDrawer
        clientId={clientId}
        open={editing !== null}
        onClose={() => setEditing(null)}
        contact={editing?.contact ?? null}
        initial={editing?.initial}
      />
      <ConfirmDialog
        open={linking !== null}
        title={`¿Ligar a ${linking?.contact.name} con su usuario?`}
        description={`Su correo, ${linking?.contact.email ?? ""}, es el de ${linking?.member.name ?? "un usuario"} en la clínica. Desde ahí su correo es el de su cuenta.`}
        confirmLabel="Ligar"
        variant="default"
        pending={link.isPending}
        error={link.isError ? submitErrorMessage(link.error) : null}
        onConfirm={() =>
          linking?.contact.id &&
          linking.member.user &&
          link.mutate({ contactId: linking.contact.id, userId: linking.member.user.userId })
        }
        onClose={() => {
          link.reset()
          setLinking(null)
        }}
      />
    </section>
  )
}

/** Cómo contactarla: el celular abre WhatsApp, el correo el programa de correo. */
function ContactWays({ contact }: { contact: ContactRow }) {
  const ways = [
    contact.phone ? (
      <a
        key="phone"
        className="underline underline-offset-2"
        href={`https://wa.me/${contact.phone.replace(/^\+/, "")}`}
        target="_blank"
        rel="noreferrer"
      >
        WhatsApp {contact.phone}
      </a>
    ) : null,
    contact.email ? (
      <a
        key="email"
        className="underline underline-offset-2 [overflow-wrap:anywhere]"
        href={`mailto:${contact.email}`}
      >
        {contact.email}
      </a>
    ) : null,
    contact.preferredChannel ? (
      <span key="channel">
        Prefiere {wordOf(CHANNEL_WORDS, contact.preferredChannel).toLowerCase()}
      </span>
    ) : null,
  ].filter(Boolean)
  if (!ways.length)
    return <span className="text-sm text-muted-foreground">Sin celular ni correo</span>
  return <span className="flex flex-wrap gap-x-3 gap-y-1 text-sm">{ways}</span>
}
