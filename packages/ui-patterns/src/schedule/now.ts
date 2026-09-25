/**
 * Reloj vivo de la agenda: el instante actual como ISO, actualizado cada
 * `intervalMs`. Lo usan las vistas para mover la línea de «ahora» y para el
 * posicionamiento inicial; quien lo monta decide el ritmo (30s por defecto:
 * la línea se mueve a la vista sin reloj de segundero).
 */

import * as React from "react"

export function useScheduleNow(intervalMs = 30_000): string {
  const [now, setNow] = React.useState(() => new Date().toISOString())

  React.useEffect(() => {
    const id = window.setInterval(() => setNow(new Date().toISOString()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])

  return now
}
