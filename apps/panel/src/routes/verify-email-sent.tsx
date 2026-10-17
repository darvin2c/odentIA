import { Button } from "@odentia/ui"
import { AuthAside, AuthSplit } from "@odentia/ui-patterns"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { MailCheck } from "lucide-react"
import { AuthLegal } from "../lib/auth-screens"

export const Route = createFileRoute("/verify-email-sent")({
  component: VerifyEmailSentPage,
})

function VerifyEmailSentPage() {
  const navigate = useNavigate()
  return (
    <AuthSplit
      title={
        <span className="flex flex-col gap-3">
          <MailCheck className="size-10 rounded-xl bg-primary/10 p-2 text-primary" aria-hidden />
          Revisa tu correo
        </span>
      }
      description="Te enviamos un enlace para confirmar tu correo. Ábrelo para seguir con tu clínica."
      aside={<AuthAside tag="Paso 2 de 4" title="Ya casi." accent="Tus agentes empiezan hoy." />}
      legal={<AuthLegal />}
    >
      <p className="text-sm text-muted-foreground">¿No llega? Revisa Spam o Promociones.</p>
      <Button variant="outline" className="w-full" onClick={() => void navigate({ to: "/login" })}>
        Ir a entrar
      </Button>
    </AuthSplit>
  )
}
