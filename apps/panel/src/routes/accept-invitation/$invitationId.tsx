import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { Button } from "@odentia/ui";
import { AuthCard, ErrorState, LoadingState } from "@odentia/ui-patterns";
import { useEffect, useRef, useState } from "react";
import { authClient } from "../../lib/auth-client";
import { tenantUrl } from "../../lib/host";

export const Route = createFileRoute("/accept-invitation/$invitationId")({
  component: AcceptInvitationPage,
});

type PageState =
  | { kind: "loading" }
  | { kind: "needs-auth"; email?: string }
  | { kind: "error"; message: string };

function AcceptInvitationPage() {
  const navigate = useNavigate();
  const { invitationId } = useParams({ from: "/accept-invitation/$invitationId" });
  const [state, setState] = useState<PageState>({ kind: "loading" });

  // StrictMode ejecuta el efecto dos veces en dev; la segunda aceptación
  // falla con "ya aceptada" y mostraría un error falso. Ejecutar una sola vez.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    async function accept() {
      const { data: session } = await authClient.getSession();
      if (!session) {
        setState({ kind: "needs-auth" });
        return;
      }
      const { data, error } = await authClient.organization.acceptInvitation({
        invitationId,
      });
      if (error) {
        setState({ kind: "error", message: "La invitación expiró o fue revocada." });
        return;
      }
      const organizationId = (data as { member?: { organizationId?: string } } | null)?.member
        ?.organizationId;
      const { data: orgs } = await authClient.organization.list();
      const slug = organizationId ? orgs?.find((org) => org.id === organizationId)?.slug : undefined;
      if (slug) {
        window.location.assign(tenantUrl(slug, "/branches"));
        return;
      }
      await navigate({ to: "/" });
    }
    void accept();
  }, [invitationId, navigate]);

  if (state.kind === "loading") {
    return (
      <AuthCard title="Aceptando invitación">
        <LoadingState message="Aceptando invitación…" />
      </AuthCard>
    );
  }

  if (state.kind === "needs-auth") {
    return (
      <AuthCard
        title="Tienes una invitación"
        description="Inicia sesión o crea tu cuenta para aceptarla."
      >
        <div className="flex flex-col gap-2">
          <Button className="w-full" onClick={() => void navigate({ to: "/login" })}>
            Iniciar sesión
          </Button>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => void navigate({ to: "/register", search: { invitationId } })}
          >
            Crear cuenta
          </Button>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Invitación no válida">
      <ErrorState message={state.message} />
      <Button variant="outline" className="w-full" onClick={() => void navigate({ to: "/login" })}>
        Ir a iniciar sesión
      </Button>
    </AuthCard>
  );
}
