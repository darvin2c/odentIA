import { Button } from "@odentia/ui"
import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { orgChecks } from "../../lib/org-access"
import { redeemSupportPass, supportEnding } from "../../lib/support-mode"

/**
 * La entrada de soporte de odentIA a la clínica (`/soporte#pase=…`) y su salida
 * (`/soporte?terminado=1`). El pase viene en el fragmento: no viaja a ningún
 * servidor ni queda en registros; se canjea una vez por la sesión de solo mirar.
 */
export const Route = createFileRoute("/soporte")({
  validateSearch: (search: Record<string, unknown>): { terminado?: 1 } =>
    search["terminado"] ? { terminado: 1 } : {},
  head: () => ({ meta: [{ title: "Soporte de odentIA" }, { name: "robots", content: "noindex" }] }),
  component: SupportEntryPage,
})

const REASONS: Record<string, string> = {
  quitado: "lo quitó",
  reemplazado: "lo reemplazó otro acceso que dio",
  caso_resuelto: "se resolvió el caso",
  sin_quien_lo_dio: "quien lo dio ya no puede darlo",
  vencido: "se cumplió el tiempo",
  salio: "saliste",
}

function SupportEntryPage() {
  const { terminado } = Route.useSearch()
  const [state, setState] = useState<"entrando" | "fallo" | "terminado">(
    terminado ? "terminado" : "entrando",
  )
  const [ending, setEnding] = useState<{
    at: string
    reason: string
    byName: string | null
  } | null>(null)
  const started = useRef(false)

  useEffect(() => {
    if (state !== "entrando" || started.current) return
    started.current = true
    const pass = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("pase")
    // El pase sale de la barra de direcciones apenas se lee.
    window.history.replaceState(null, "", window.location.pathname)
    if (!pass) {
      setState("fallo")
      return
    }
    redeemSupportPass(pass)
      .then(() => {
        orgChecks.access = null
        window.location.replace("/home")
      })
      .catch(() => setState("fallo"))
  }, [state])

  useEffect(() => {
    if (state !== "terminado") return
    orgChecks.access = null
    void supportEnding()
      .then(setEnding)
      .catch(() => undefined)
  }, [state])

  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4">
      {state === "entrando" ? (
        <p role="status" className="text-muted-foreground">
          Entrando a la clínica para mirar…
        </p>
      ) : state === "fallo" ? (
        <>
          <h1 className="text-xl font-semibold">El pase no sirve</h1>
          <p className="text-muted-foreground">
            Un pase sirve una sola vez y dura un minuto. Pide otro desde el caso en la
            administración.
          </p>
        </>
      ) : (
        <>
          <h1 className="text-xl font-semibold">El acceso terminó</h1>
          <p className="text-muted-foreground">
            {ending
              ? `A las ${time(ending.at)}: ${ending.byName && ending.reason === "quitado" ? `lo quitó ${ending.byName}` : (REASONS[ending.reason] ?? "terminó")}.`
              : "Ya no puedes mirar esta clínica."}{" "}
            Si hace falta seguir, pídelo otra vez desde el caso en la administración.
          </p>
          <div>
            <Button variant="outline" onClick={() => window.close()}>
              Cerrar esta pestaña
            </Button>
          </div>
        </>
      )}
    </main>
  )
}
