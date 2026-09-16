import { Button, toast } from "@odentia/ui"
import { authClient } from "./auth-client"

/** "G" oficial de Google: los colores son parte del asset de marca, no tokens del theme. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4 shrink-0">
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.54 5.54 0 0 1-2.4 3.63v3.02h3.86c2.26-2.09 3.56-5.17 3.56-8.89Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3.02c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A11.99 11.99 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.27a7.2 7.2 0 0 1 0-4.54V6.64H1.29a11.99 11.99 0 0 0 0 10.72l3.98-3.09Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.69 1.29 6.64l3.98 3.09C6.22 6.88 8.87 4.77 12 4.77Z"
      />
    </svg>
  )
}

/**
 * Acceso OAuth con Google. Redirige al proveedor; Better Auth devuelve a
 * `callbackURL` ya autenticado. Si no hay `GOOGLE_CLIENT_ID/SECRET` en la API,
 * la petición falla y se muestra el toast en vez de romper la pantalla.
 */
export function GoogleAuthButton({ label, callbackURL }: { label: string; callbackURL: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      className="w-full"
      onClick={async () => {
        try {
          const { error } = await authClient.signIn.social({ provider: "google", callbackURL })
          if (error) throw error
        } catch {
          toast.error("No pudimos conectar con Google. Inténtalo de nuevo.")
        }
      }}
    >
      <GoogleMark />
      {label}
    </Button>
  )
}
