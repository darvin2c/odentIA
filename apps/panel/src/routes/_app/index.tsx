import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Button } from "@odentia/ui";
import { EmptyState, LoadingState, PageHeader } from "@odentia/ui-patterns";
import { Building2 } from "lucide-react";
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
        {orgsQuery.isLoading ? (
          <LoadingState message="Cargando organizaciones…" />
        ) : orgs.length === 0 ? (
          <EmptyState
            icon={Building2}
            title="Sin organizaciones"
            description="Crea tu primera organización para empezar a operar."
            actionLabel="Crear organización"
            onAction={() => void navigate({ to: "/onboarding" })}
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
