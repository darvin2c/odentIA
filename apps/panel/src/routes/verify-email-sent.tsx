import { Button } from "@odentia/ui"
import { AuthCard } from "@odentia/ui-patterns"
import { createFileRoute, useNavigate } from "@tanstack/react-router"

export const Route = createFileRoute("/verify-email-sent")({
  component: VerifyEmailSentPage,
})

function VerifyEmailSentPage() {
  const navigate = useNavigate()
  return (
    <AuthCard
      title="Revisa tu correo"
      description="Te enviamos un enlace de verificación. Ábrelo para activar tu cuenta."
    >
      <Button variant="outline" className="w-full" onClick={() => void navigate({ to: "/login" })}>
        Ir a iniciar sesión
      </Button>
    </AuthCard>
  )
}
