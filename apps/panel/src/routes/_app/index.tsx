import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Button } from "@odentia/ui";
import { LoadingState, PageHeader } from "@odentia/ui-patterns";
import { Building2 } from "lucide-react";
import { useEffect } from "react";
import { authClient } from "../../lib/auth-client";
import { tenantUrl } from "../../lib/host";

export const Route = createFileRoute("/_app/")({
  component: OrgsPage,
});

function OrgsPage() {
  const navigate = useNavigate();
  const orgsQuery = useQuery({
    queryKey: ["orgs"],
    queryFn: async () => (await authClient.organization.list()).data ?? [],
  });

  const orgs = orgsQuery.data ?? [];

  // Usuarios nuevos (p. ej. recién llegados de Google con callbackURL "/")
  // van directo al wizard de onboarding cuando aún no tienen organizaciones.
  useEffect(() => {
    if (!orgsQuery.isLoading && !orgsQuery.error && orgs.length === 0) {
      void navigate({ to: "/onboarding" });
    }
  }, [orgsQuery.isLoading, orgsQuery.error, orgs.length, navigate]);

  return (
    <>
      <PageHeader
        title="Tus organizaciones"
        actions={
          <Button variant="outline" onClick={() => void navigate({ to: "/onboarding" })}>
            Crear organización
          </Button>
        }
      />
      <div className="mt-8">
        {orgsQuery.isLoading || orgs.length === 0 ? (
          <LoadingState
            message={orgs.length === 0 ? "Preparando tu espacio…" : "Cargando organizaciones…"}
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {orgs.map((org) => (
              <li key={org.id}>
                <a
                  href={tenantUrl(org.slug, "/branches")}
                  className="flex items-center gap-3 rounded-lg border p-4 hover:bg-muted"
                >
                  <Building2 className="size-5 shrink-0" aria-hidden />
                  <span>
                    <span className="block text-sm font-medium">{org.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {org.slug}.{import.meta.env.VITE_BASE_DOMAIN as string}
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
