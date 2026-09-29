import * as React from "react"

/**
 * Utilidades globales que el layout inyecta en cada `PageHeader` (avisos,
 * selector de organización…). Viven aquí para que el header compartido no
 * conozca componentes de ninguna app: sin proveedor, el `PageHeader` no
 * monta nada en ese hueco.
 */
const HeaderUtilitiesContext = React.createContext<React.ReactNode>(null)

export function HeaderUtilitiesProvider({
  value,
  children,
}: {
  value: React.ReactNode
  children: React.ReactNode
}) {
  return <HeaderUtilitiesContext.Provider value={value}>{children}</HeaderUtilitiesContext.Provider>
}

export function useHeaderUtilities(): React.ReactNode {
  return React.useContext(HeaderUtilitiesContext)
}
