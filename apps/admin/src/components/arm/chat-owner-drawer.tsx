/**
 * «¿De quién es este WhatsApp?» (o este Instagram, este Messenger): una
 * conversación que llegó sin cliente se le asigna a uno. Solo Administración
 * (el servidor lo exige igual). Cuatro caminos, como el lienzo: el contacto
 * que tiene ese celular (si es uno solo; nunca se liga solo por el teléfono),
 * un cliente que ya tenemos (buscarlo y, si se quiere, elegir la persona), una
 * clínica nueva («Nuevo cliente» con lo que se sabe) o «No es una clínica»,
 * que se deshace desde el aviso. «Mover a otra clínica» es el mismo buscador.
 */
import { Button, toast } from "@odentia/ui"
import {
  common,
  FormDrawer,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ChevronRight } from "lucide-react"
import { useState } from "react"
import { z } from "zod"
import {
  CHAT_CHANNEL_WORDS,
  type ChatChannel,
  type ChatSuggestion,
  chatKey,
  markNotClinic,
  momentWords,
  phoneWords,
  undoNotClinic,
} from "./chat-api"
import { fetchClientDetail, useClientContacts } from "./client-queries"
import { ClientSearch } from "./client-search"
import { invalidateArm } from "./hoy-links"
import { NewClientDrawer, type NewClientValues } from "./new-client-drawer"

/** Lo que se sabe de la conversación para decidir de quién es. */
export interface ChatOwnerSubject {
  chatId: string
  channel: ChatChannel
  address: string
  displayName: string | null
  lastBody: string | null
  receivedAt: string | null
  suggestion: ChatSuggestion | null
}

export interface ChatOwnerDrawerProps {
  subject: ChatOwnerSubject
  /** «decidir»: los cuatro caminos; «mover»: directo al buscador (ya tiene cliente). */
  mode?: "decidir" | "mover"
  /** El cliente que tiene ahora (al mover): no se ofrece de nuevo. */
  currentClientId?: string | null
  onAssign: (input: { clientId: string; contactId: string | null }) => Promise<void>
  onClose: () => void
}

/** «este WhatsApp», «este Instagram», «este Messenger». */
const ofChannel = (channel: ChatChannel) => `este ${CHAT_CHANNEL_WORDS[channel]}`

/** Lo que se sabe para «Nuevo cliente»: el celular en WhatsApp; en los otros, el nombre o @usuario. */
export function newClientFromChat(subject: ChatOwnerSubject): Partial<NewClientValues> {
  if (subject.channel === "whatsapp")
    return {
      contactName: subject.displayName ?? "",
      phone: subject.address,
      origin: "whatsapp",
      originDetail: "Nos escribió por WhatsApp",
    }
  const who = subject.displayName ? ` (${subject.displayName})` : ""
  return {
    contactName: subject.displayName?.replace(/^@/, "") ?? "",
    origin: "redes",
    originDetail: `Nos escribió por ${CHAT_CHANNEL_WORDS[subject.channel]}${who}`,
  }
}

/** Quién escribió, en una línea: el celular o la cuenta. */
export const subjectWho = (
  subject: Pick<ChatOwnerSubject, "channel" | "address" | "displayName">,
) =>
  subject.channel === "whatsapp"
    ? `${phoneWords(subject.address)}${subject.displayName ? ` · ${subject.displayName}` : ""}`
    : (subject.displayName ?? `Una cuenta de ${CHAT_CHANNEL_WORDS[subject.channel]}`)

/**
 * «No es una clínica», con «Deshacer» en el mismo aviso. Sus próximos
 * mensajes siguen entrando, sin volver a Hoy.
 */
export function useNotClinic() {
  const queryClient = useQueryClient()
  const refresh = (chatId: string) => {
    invalidateArm(queryClient, null)
    void queryClient.invalidateQueries({ queryKey: chatKey(chatId) })
  }
  // «Deshacer» sale en el aviso, cuando el cajón ya se cerró: no depende de que siga montado.
  const undoNow = async (chatId: string) => {
    try {
      await undoNotClinic(chatId)
      refresh(chatId)
      toast.success("Listo: vuelve a estar por decidir")
    } catch (error) {
      toast.error(submitErrorMessage(error))
    }
  }
  const undo = useMutation({ mutationFn: undoNow })
  const mark = useMutation({
    mutationFn: (chatId: string) => markNotClinic(chatId),
    onSuccess: (_data, chatId) => {
      refresh(chatId)
      toast.success("Listo: no es una clínica. Sus próximos mensajes no vuelven a Hoy.", {
        action: { label: "Deshacer", onClick: () => void undoNow(chatId) },
      })
    },
  })
  return { mark, undo }
}

export function ChatOwnerDrawer(props: ChatOwnerDrawerProps) {
  const [phase, setPhase] = useState<"opciones" | "cliente" | "nueva">(
    props.mode === "mover" ? "cliente" : "opciones",
  )
  if (phase === "nueva")
    return (
      <NewClientDrawer
        open
        title="Es una clínica nueva"
        initial={newClientFromChat(props.subject)}
        onCreated={async (clientId) => {
          // La persona que se creó con este celular es quien escribe.
          const detail = await fetchClientDetail(clientId).catch(() => null)
          const contact =
            props.subject.channel === "whatsapp"
              ? detail?.contacts.find((row) => row.id && row.phone === props.subject.address)
              : undefined
          await props.onAssign({ clientId, contactId: contact?.id ?? null })
        }}
        onClose={props.onClose}
      />
    )
  if (phase === "cliente")
    return (
      <PickClient {...props} onBack={props.mode === "mover" ? null : () => setPhase("opciones")} />
    )
  return <Options {...props} onPick={() => setPhase("cliente")} onNew={() => setPhase("nueva")} />
}

function SubjectMessage({ subject }: { subject: ChatOwnerSubject }) {
  return (
    <div className="rounded-lg bg-muted p-3 text-sm">
      <p className="font-medium [overflow-wrap:anywhere]">{subjectWho(subject)}</p>
      {subject.receivedAt ? (
        <p className="text-xs text-muted-foreground">Escribió {momentWords(subject.receivedAt)}</p>
      ) : null}
      <blockquote className="mt-2 whitespace-pre-wrap border-l-2 pl-3 [overflow-wrap:anywhere]">
        {subject.lastBody ?? "Mandó un archivo"}
      </blockquote>
    </div>
  )
}

/** Un camino: el botón dice qué hace y, debajo, qué pasa después. */
function Way({
  label,
  hint,
  onClick,
  disabled,
  primary = false,
}: {
  label: string
  hint?: string
  onClick: () => void
  disabled?: boolean
  primary?: boolean
}) {
  return (
    <li className="flex flex-col gap-1">
      <Button
        type="button"
        variant={primary ? "default" : "outline"}
        className="h-auto min-h-10 w-full justify-between whitespace-normal py-2 text-left"
        disabled={disabled}
        onClick={onClick}
      >
        <span className="[overflow-wrap:anywhere]">{label}</span>
        <ChevronRight aria-hidden className="size-4 shrink-0" />
      </Button>
      {hint ? <p className="px-1 text-xs text-muted-foreground">{hint}</p> : null}
    </li>
  )
}

function Options({
  subject,
  onAssign,
  onClose,
  onPick,
  onNew,
}: ChatOwnerDrawerProps & { onPick: () => void; onNew: () => void }) {
  const { mark } = useNotClinic()
  const [busy, setBusy] = useState(false)
  const suggestion = subject.suggestion
  return (
    <FormDrawer
      open
      onClose={onClose}
      title={`¿De quién es ${ofChannel(subject.channel)}?`}
      onSubmit={(event) => event.preventDefault()}
      hideSubmit
      isSubmitting={busy || mark.isPending}
      cancelLabel={common.actions.close}
    >
      <div className="flex flex-col gap-5">
        <SubjectMessage subject={subject} />
        {suggestion ? (
          <p className="text-sm">
            Ese celular es de un contacto: {suggestion.contactName}, de {suggestion.clientName}.
          </p>
        ) : null}
        <ul className="flex flex-col gap-3">
          {suggestion ? (
            <Way
              primary
              label={`Es de ${suggestion.contactName}`}
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await onAssign({ clientId: suggestion.clientId, contactId: suggestion.contactId })
                  onClose()
                } catch (error) {
                  toast.error(submitErrorMessage(error))
                } finally {
                  setBusy(false)
                }
              }}
            />
          ) : null}
          <Way label="Es de un cliente que ya tenemos" disabled={busy} onClick={onPick} />
          <Way
            label="Es una clínica nueva"
            hint={
              subject.channel === "whatsapp"
                ? "Abre «Cliente nuevo» con su número. El nombre de la clínica y el producto se llenan cuando los sepas."
                : "Abre «Cliente nuevo» con su nombre de la cuenta. El celular o el correo, la clínica y el producto se llenan cuando los sepas."
            }
            disabled={busy}
            onClick={onNew}
          />
          <Way
            label="No es una clínica"
            hint="Un paciente, un proveedor o spam. Sus próximos mensajes no vuelven a Hoy. Se puede deshacer."
            disabled={busy || mark.isPending}
            onClick={() =>
              mark.mutate(subject.chatId, {
                onSuccess: onClose,
                onError: (error) => toast.error(submitErrorMessage(error)),
              })
            }
          />
        </ul>
        <p className="text-xs text-muted-foreground">
          Mientras nadie decide, se puede responder igual. Cuando se decide, todos sus mensajes, los
          de antes y los que vengan, quedan en esa ficha.
        </p>
      </div>
    </FormDrawer>
  )
}

const pickSchema = z.object({
  clientId: z.string().min(1, "Elige el cliente"),
  clientName: z.string(),
  contactId: z.string(),
})

function PickClient({
  subject,
  mode = "decidir",
  currentClientId = null,
  onAssign,
  onClose,
  onBack,
}: ChatOwnerDrawerProps & { onBack: (() => void) | null }) {
  const form = useAppForm({
    defaultValues: { clientId: "", clientName: "", contactId: "" },
    validators: {
      onSubmit: pickSchema.refine((value) => value.clientId !== currentClientId, {
        path: ["clientId"],
        message: "Ya es de esta clínica: elige otra",
      }),
    },
    onSubmit: async ({ value, formApi }) => {
      await onAssign({ clientId: value.clientId, contactId: value.contactId || null })
      formApi.reset(value)
      onClose()
    },
  })
  const clientId = useStore(form.store, (state) => state.values.clientId)
  const contacts = useClientContacts(clientId, Boolean(clientId))
  const people = (contacts.data ?? []).filter((row) => row.id && row.source === "contacto")
  return (
    <FormDrawer
      {...useFormSurface(form)}
      open
      onClose={onClose}
      title={
        mode === "mover"
          ? "Mover a otra clínica"
          : `¿De qué cliente es ${ofChannel(subject.channel)}?`
      }
      description={subjectWho(subject)}
      submitLabel={mode === "mover" ? "Mover" : "Asignar"}
      cancelLabel={common.actions.cancel}
      {...(onBack ? { secondaryAction: { label: "Volver", onClick: onBack } } : {})}
    >
      <div className="flex flex-col gap-5">
        {mode === "mover" ? (
          <p className="text-sm text-muted-foreground">
            Sus mensajes, sus archivos y lo que se le respondió pasan a la clínica que elijas.
          </p>
        ) : (
          <SubjectMessage subject={subject} />
        )}
        <form.AppField name="clientId">
          {(field) => (
            <field.Group legend="Cliente">
              {(control) => (
                <ClientSearch
                  id="chat-buscar-cliente"
                  control={control}
                  value={field.state.value}
                  onChange={(next, name) => {
                    field.handleChange(next)
                    field.handleBlur()
                    form.setFieldValue("clientName", name)
                    // La persona elegida era de otro cliente.
                    form.setFieldValue("contactId", "")
                  }}
                />
              )}
            </field.Group>
          )}
        </form.AppField>
        {clientId ? (
          // La persona del cliente que escribe (opcional): recibe este celular si no tenía uno.
          <form.AppField name="contactId">
            {(field) => (
              <field.SelectField
                id="chat-persona"
                label="Quién escribe (opcional)"
                description={
                  contacts.isPending
                    ? "Cargando sus personas…"
                    : contacts.isError
                      ? "No pude traer sus personas: puedes asignarlo sin elegir."
                      : subject.channel === "whatsapp"
                        ? "Si no tenía celular, queda este."
                        : undefined
                }
                options={[
                  { value: "", label: "Sin elegir persona" },
                  ...people.map((row) => ({
                    value: row.id as string,
                    label: row.phone ? `${row.name} · ${row.phone}` : row.name,
                  })),
                ]}
              />
            )}
          </form.AppField>
        ) : null}
      </div>
    </FormDrawer>
  )
}
