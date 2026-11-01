import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  ScrollArea,
} from "@odentia/ui"
import { useState } from "react"
import { type InboxTopic, useMyUserId, useOrgMembers } from "../../lib/crm"

/** Lo que el diálogo necesita saber de un tema: en la Bandeja y en el resumen del caso. */
export interface PassableTopic {
  id: string
  kind?: InboxTopic["kind"]
  assigneeUserId: string | null
  /** La frase que recuerda de qué trata. */
  quote: string
}

const RECEIVER_ROLES = ["owner", "admin", "reception", "clinician", "cashier"]

/** «Pasar este tema a…»: con muchas personas en el equipo se busca, sin llenar el menú del tema. */
export function PassTopicDialog({
  topic,
  pending,
  onClose,
  onPass,
}: {
  topic: PassableTopic | null
  pending: boolean
  onClose: () => void
  /** `userId` es quien mira si se lo pasa a sí mismo. */
  onPass: (topic: PassableTopic, userId: string, toMe: boolean) => void
}) {
  const members = useOrgMembers()
  const myUserId = useMyUserId()
  const [query, setQuery] = useState("")
  const text = query.trim().toLowerCase()
  const options = topic
    ? members
        .filter((member) => RECEIVER_ROLES.includes(member.role))
        // Caja solo recibe pagos (decisión 3); el servidor también lo exige.
        .filter((member) => member.userId !== topic.assigneeUserId && (member.role !== "cashier" || topic.kind === "pago"))
        .filter((member) => member.user.name.toLowerCase().includes(text))
    : []
  return (
    <Dialog
      open={topic !== null}
      onOpenChange={(open) => {
        if (!open) {
          setQuery("")
          onClose()
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pasar este tema a…</DialogTitle>
          {topic ? <DialogDescription>«{topic.quote}»</DialogDescription> : null}
        </DialogHeader>
        <Input aria-label="Buscar en el equipo" placeholder="Buscar en el equipo" value={query} onChange={(event) => setQuery(event.target.value)} />
        <ScrollArea className="max-h-64 [&_[data-slot=scroll-area-viewport]]:max-h-64">
          <ul className="flex flex-col gap-0.5">
            {options.map((member) => (
              <li key={member.userId}>
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11 w-full justify-start sm:min-h-9"
                  disabled={pending}
                  onClick={() => {
                    setQuery("")
                    if (topic) onPass(topic, member.userId, member.userId === myUserId)
                  }}
                >
                  {member.userId === myUserId ? "Pasármelo" : member.user.name}
                </Button>
              </li>
            ))}
            {options.length === 0 ? <li className="px-3 py-2 text-sm text-muted-foreground">Nadie coincide con la búsqueda.</li> : null}
          </ul>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
