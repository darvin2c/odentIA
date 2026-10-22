import * as React from "react"

/**
 * Utilidades globales que el layout inyecta en cada `PageHeader` (buscar,
 * ayuda, avisos, agente) y sus opciones del menú ⋯. Viven aquí para que el
 * encabezado compartido no conozca componentes de ninguna app: sin proveedor,
 * el `PageHeader` no monta nada en ese hueco.
 */
export interface HeaderUtilities {
  /** Botones de la fila: con icono y texto desde tableta; solo icono en el teléfono. */
  utilities?: React.ReactNode
  /** Opciones que el menú ⋯ añade a las de la página (p. ej. «Ayuda» bajo web). */
  menuItems?: React.ReactNode
}

const HeaderUtilitiesContext = React.createContext<HeaderUtilities | null>(null)

export function HeaderUtilitiesProvider({
  value,
  children,
}: {
  value: HeaderUtilities
  children: React.ReactNode
}) {
  return <HeaderUtilitiesContext.Provider value={value}>{children}</HeaderUtilitiesContext.Provider>
}

export function useHeaderUtilities(): HeaderUtilities | null {
  return React.useContext(HeaderUtilitiesContext)
}
