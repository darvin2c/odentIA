import { Button } from "@odentia/ui"
import { personFirstName } from "@odentia/ui-patterns"
import { useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Sun, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { apiFetch } from "../../lib/api"
import { authClient } from "../../lib/auth-client"
import { awayText, greetingAt, type HomeAway } from "../../lib/home-away"

/** Tras este rato sin tocar nada, el siguiente toque cuenta como volver a Inicio. */
const IDLE_MS = 10 * 60_000

/**
 * «Mientras no estabas» (decisión 8 del lienzo de acceso): Inicio le dice al
 * servidor cuándo la persona la está mirando —al abrirla, al volver a la
 * pestaña y al primer toque tras un rato quieta— y la primera vez del día
 * recibe lo que hicieron los agentes desde la visita anterior. La línea se
 * queda hasta cerrarla con la ✕; no vuelve ese día.
 */
export function AwayLine({ canSeeAgenda }: { canSeeAgenda: boolean }) {
  const [away, setAway] = useState<HomeAway | null>(null)
  const [closed, setClosed] = useState(false)
  const lastSent = useRef(0)
  const firstName = personFirstName(authClient.useSession().data?.user.name)
  const queryClient = useQueryClient()

  useEffect(() => {
    const visit = () => {
      lastSent.current = Date.now()
      void apiFetch<{ data: { away: HomeAway | null } }>("/api/workspace/visit", {
        method: "POST",
        body: "{}",
      })
        .then(({ data }) => {
          if (data.away) {
            setAway(data.away)
            setClosed(false)
            // Lo que trajo el agente ya está en «Te espera»: se refresca para verlo.
            void queryClient.invalidateQueries({ queryKey: ["workspace-home"] })
          }
        })
        .catch(() => {
          // Sin la línea Inicio sigue igual; se intenta en la próxima visita.
        })
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") visit()
    }
    const onActivity = () => {
      if (Date.now() - lastSent.current > IDLE_MS) visit()
    }
    visit()
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("pointerdown", onActivity)
    window.addEventListener("keydown", onActivity)
    return () => {
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("pointerdown", onActivity)
      window.removeEventListener("keydown", onActivity)
    }
  }, [queryClient])

  if (!away || closed) return null
  // Los casos no llevan botón: están justo debajo, en «Te espera».
  const action =
    away.appointments && canSeeAgenda ? (
      <Button size="sm" variant="outline" className="bg-card" render={<Link to="/agenda" />}>
        Abrir la Agenda
      </Button>
    ) : null

  return (
    <section
      aria-label="Mientras no estabas"
      className="flex flex-wrap items-center gap-3 rounded-2xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm"
    >
      <span
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-card text-primary"
      >
        <Sun className="size-4" />
      </span>
      <p className="min-w-0 flex-1 basis-60">
        <strong>
          {greetingAt()}
          {firstName ? `, ${firstName}` : ""}.
        </strong>{" "}
        {awayText(away)}
      </p>
      {action}
      <Button size="icon-sm" variant="ghost" aria-label="Cerrar" onClick={() => setClosed(true)}>
        <X aria-hidden />
      </Button>
    </section>
  )
}
