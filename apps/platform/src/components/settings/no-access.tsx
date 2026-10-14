import { EmptyState } from "@odentia/ui-patterns"
import { Lock } from "lucide-react"

/**
 * Sin permiso, todo apartado de Configuración dice lo mismo: quién lo
 * configura, sin nombrar permisos ni roles internos.
 */
export function SettingsNoAccess() {
  return (
    <EmptyState
      icon={Lock}
      title="Esto lo configura quien administra la clínica"
      description="Si necesitas cambiar algo aquí, pídeselo a esa persona."
    />
  )
}
