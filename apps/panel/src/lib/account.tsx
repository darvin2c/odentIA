import { AccountProvider } from "@odentia/ui-patterns"
import type { ReactNode } from "react"
import { useKnownStaffRecord } from "./admin-access"
import { API_URL, authClient } from "./auth-client"
import { panelWords } from "./brand"

/**
 * Las pantallas de la cuenta (Mi perfil y Soporte) son comunes a todas las apps
 * (`@odentia/ui-patterns`, ADR 0216): el panel les pasa su cliente de la cuenta, su API y su
 * marca.
 */
export function PanelAccount({ children }: { children: ReactNode }) {
  const knownStaff = useKnownStaffRecord()
  return (
    <AccountProvider
      value={{
        client: authClient,
        apiUrl: API_URL,
        appName: panelWords.name,
        profilePath: "/profile",
        emailExample: "nombre@clinica.com",
        knownStaff,
      }}
    >
      {children}
    </AccountProvider>
  )
}
