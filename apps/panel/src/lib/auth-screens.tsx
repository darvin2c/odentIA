import { AuthAside } from "@odentia/ui-patterns"
import { webUrl } from "./host"
import { panelWords } from "./brand"

/** Pie de las pantallas de acceso: los documentos y la ayuda viven en la web. */
export function AuthLegal() {
  return (
    <>
      <a href={webUrl("/privacidad")} className="hover:underline">
        Privacidad
      </a>
      <a href={webUrl("/terminos")} className="hover:underline">
        Términos
      </a>
      <a href={webUrl("/contacto")} className="hover:underline">
        Ayuda
      </a>
    </>
  )
}

/** Entrar recibe, no vende (lienzo «Entrar: dos fondos», prueba 2). */
export function WelcomeAside() {
  return (
    <AuthAside tag={`Tu ${panelWords.place.one}`} title="Omnicanal" accent="y agéntica.">
      <p>Tus agentes siguieron trabajando mientras no estabas.</p>
    </AuthAside>
  )
}

/** Recuperar el acceso tranquiliza: la clínica no se detiene mientras tanto. */
export function RecoverAside() {
  return (
    <AuthAside tag="Todo sigue en marcha" title={`Tu ${panelWords.place.one}`} accent="sigue atendiendo.">
      <p>Mientras recuperas tu acceso, tus agentes siguen respondiendo y agendando.</p>
    </AuthAside>
  )
}

/** Mensaje de error de una pantalla de acceso: junto al campo o al botón, no en un aviso que se va. */
export function AuthAlert({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <div
      id={id}
      role="alert"
      className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
    >
      {children}
    </div>
  )
}
