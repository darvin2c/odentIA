import { CONTACT_RELATIONSHIP_LABELS } from "@odentia/clinical"
import { Button } from "@odentia/ui"
import { useState } from "react"
import type { PatientFull } from "../../lib/patients"
import { ContactWorkspace } from "../crm/contact-workspace"

/**
 * Seguimiento comercial dentro de la ficha: oportunidades, tareas, notas y
 * propuestas del agente de cada interlocutor de la persona. Es el mismo espacio
 * de trabajo de la bandeja; aquí se elige con quién se habla.
 */
export function SeguimientoPanel({ detail }: { detail: PatientFull }) {
  const own = detail.contacts.find((link) => link.relationship === "self")
  const preferred = detail.contacts.find((link) => link.isPreferred)
  const [contactId, setContactId] = useState(own?.contactId ?? preferred?.contactId ?? "")
  const selected = detail.contacts.find((link) => link.contactId === contactId) ?? detail.contacts[0]

  if (!selected)
    return <p className="text-sm text-muted-foreground">Esta persona aún no tiene interlocutores.</p>

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {detail.contacts.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Seguimiento con</span>
          {detail.contacts.map((link) => (
            <Button
              key={link.contactId}
              size="sm"
              variant={link.contactId === selected.contactId ? "default" : "outline"}
              aria-pressed={link.contactId === selected.contactId}
              onClick={() => setContactId(link.contactId)}
            >
              {link.displayName} · {CONTACT_RELATIONSHIP_LABELS[link.relationship] ?? link.relationship}
            </Button>
          ))}
        </div>
      ) : null}
      <div className="min-w-0 overflow-hidden rounded-xl border bg-card">
        <ContactWorkspace key={selected.contactId} contactId={selected.contactId} />
      </div>
    </div>
  )
}
