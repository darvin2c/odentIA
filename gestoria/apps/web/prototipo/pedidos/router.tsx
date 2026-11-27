import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import { createContext, type ReactNode, useContext, useState } from "react"

/**
 * La barra de filtros de la app (`FilterBar`) lee y escribe sus filtros con el router de la app.
 * El prototipo navega con «#»: le da un router en memoria solo para eso, y los filtros viven en
 * `ListSearchScope`, como una lista abierta encima de otra pantalla.
 */
const Slot = createContext<ReactNode>(null)
const Contenido = () => useContext(Slot)

export function ConRouter({ children }: { children: ReactNode }) {
  const [router] = useState(() =>
    createRouter({
      routeTree: createRootRoute({ component: Contenido }),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    }),
  )
  return (
    <Slot.Provider value={children}>
      <RouterProvider router={router} />
    </Slot.Provider>
  )
}
