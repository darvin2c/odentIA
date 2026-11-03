import { createContext, useContext } from "react"

const PersonArchived = createContext(false)

/** La página de la persona lo dice una vez: lo que hay debajo no vuelve a pedirlo. */
export const PersonArchivedProvider = PersonArchived.Provider

/**
 * Una ficha archivada se puede leer, pero no ofrece trabajo nuevo: la misma
 * regla de su cabecera en lo que se pinta debajo («Reservar cita», «Atender»,
 * «Agregar alergia», «Nueva tarea»). Fuera de la página, nunca está archivada.
 */
export function usePersonArchived(): boolean {
  return useContext(PersonArchived)
}
