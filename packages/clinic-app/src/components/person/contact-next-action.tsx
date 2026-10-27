/**
 * El botón de «Siguiente paso» de Contactos nuevos hace lo que dice (lienzo
 * «Paciente: cada acción en su sitio»): responder y escribir abren su
 * conversación en la Bandeja, que es donde se escribe; «Reenviar enlace» la
 * abre con «Su enlace» preparado; «Registrar» abre el alta aquí mismo. Antes los
 * siete textos llevaban al mismo perfil.
 */
import { Button, buttonVariants } from "@odentia/ui"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { type PersonListItem, situationAction, usePerson } from "../../lib/people"
import { NewPatientDrawer } from "../patient/new-patient-drawer"
import { WriteToPersonDialog } from "../write-to-person"

export function ContactNextAction({ row }: { row: PersonListItem }): React.JSX.Element {
  const [open, setOpen] = useState<"write" | "register" | null>(null)
  const label = situationAction(row.situation)
  const target = [{ contactId: row.id, displayName: row.displayName }]
  if (row.situation === "sin_pendientes" || row.situation === "oportunidad")
    return (
      <Link
        to="/people/$personId"
        params={{ personId: row.id }}
        search={row.situation === "oportunidad" ? { tab: "conversaciones" } : {}}
        className={buttonVariants({ size: "sm", variant: "outline" })}
      >
        {label}
      </Link>
    )
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen(row.situation === "sin_conversacion" ? "register" : "write")}
      >
        {label}
      </Button>
      {open === "write" ? (
        <WriteToPersonDialog
          open
          onClose={() => setOpen(null)}
          people={target}
          prepareRegistration={row.situation === "enlace"}
        />
      ) : null}
      {open === "register" ? <RegisterContact personId={row.id} onClose={() => setOpen(null)} /> : null}
    </>
  )
}

/** El alta del paciente sobre la lista, con la persona ya cargada. */
function RegisterContact({ personId, onClose }: { personId: string; onClose: () => void }): React.JSX.Element | null {
  const person = usePerson(personId).data?.data ?? null
  if (!person) return null
  return <NewPatientDrawer open onClose={onClose} target={{ kind: "person", person }} />
}
