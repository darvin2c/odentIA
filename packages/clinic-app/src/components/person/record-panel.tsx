import { useQueryClient } from "@tanstack/react-query"
import { createContext, lazy, type ReactNode, Suspense, useContext, useState } from "react"
import { isReceiptOnly, useOrgEvents } from "../../lib/org-events"
import type { PersonPanelTarget } from "./person-panel"

const PersonPanel = lazy(() => import("./person-panel").then((m) => ({ default: m.PersonPanel })))

const OpenRecordPanel = createContext<((target: PersonPanelTarget) => void) | null>(null)

/** Abre la conversación de la persona ahí mismo, sin salir de su ficha. */
export function useOpenRecordPanel(): ((target: PersonPanelTarget) => void) | null {
  return useContext(OpenRecordPanel)
}

/**
 * El panel de la persona dentro de su ficha: «Abrir», «Escribirle» y «Ver su
 * conversación» se quedan aquí. Desde la ficha se le empieza a hablar, no se
 * responde lo que espera (`fromRecord`): lo decide el servidor. Se actualiza si
 * la persona responde mientras está abierto. Adjuntos, audio y elegir entre
 * varios temas siguen en la Bandeja, con «Ver toda la conversación».
 */
export function RecordPanelProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [target, setTarget] = useState<PersonPanelTarget | null>(null)
  useOrgEvents(["message.created", "message.updated", "conversation.updated"], (kind, data) => {
    if (target && !isReceiptOnly(kind, data)) void queryClient.invalidateQueries({ queryKey: ["person-panel"] })
  })
  return (
    <OpenRecordPanel.Provider value={setTarget}>
      {children}
      {target ? (
        <Suspense fallback={null}>
          <PersonPanel
            target={target}
            fromRecord
            onSwitchConversation={(conversationId) => setTarget({ conversationId, name: target.name })}
            onClose={() => setTarget(null)}
            onChanged={() => void queryClient.invalidateQueries({ queryKey: ["person-conversations"] })}
          />
        </Suspense>
      ) : null}
    </OpenRecordPanel.Provider>
  )
}
