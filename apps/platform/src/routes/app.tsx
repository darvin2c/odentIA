import { useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@odentia/ui";
import { AppShell, LoadingState, type AppShellNavEntry } from "@odentia/ui-patterns";
import { Building2, FlaskConical, Users } from "lucide-react";
import { authClient } from "../lib/auth-client";
import { requireVerifiedSession, ssrFetchOptions } from "../lib/guards";

export const Route = createFileRoute("/app")({
  beforeLoad: async () => {
    const session = await requireVerifiedSession();
    const fetchOptions = ssrFetchOptions();
    const { data: orgs } = await authClient.organization.list({ fetchOptions });
    if (!orgs || orgs.length === 0) {
      throw redirect({ to: "/onboarding" });
    }
    const { data: active } = await authClient.organization.getFullOrganization({
      fetchOptions,
    });
    if (!active) {
      await authClient.organization.setActive({ organizationId: orgs[0]!.id, fetchOptions });
    }
    return { session };
  },
  component: AppLayout,
});

const navItems: AppShellNavEntry[] = [
  { label: "Sucursales", to: "/app/branches", icon: Building2 },
  { label: "Miembros", to: "/app/members", icon: Users },
  { label: "Demo", to: "/app/demo", icon: FlaskConical },
];

function RouterLink({
  to,
  className,
  children,
  title,
  onClick,
}: {
  to: string;
  className?: string;
  children: React.ReactNode;
  title?: string;
  onClick?: () => void;
}) {
  return (
    <Link to={to} className={className} title={title} onClick={onClick}>
      {children}
    </Link>
  );
}

function OrgSwitcher() {
  const navigate = useNavigate();
  const { data: orgs } = useQuery({
    queryKey: ["orgs"],
    queryFn: async () => (await authClient.organization.list()).data ?? [],
  });
  const { data: active } = useQuery({
    queryKey: ["active-org"],
    queryFn: async () => (await authClient.organization.getFullOrganization()).data,
  });

  if (!orgs || orgs.length <= 1) {
    return <span className="text-sm font-medium">{active?.name ?? ""}</span>;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="text-sm font-medium underline-offset-2 hover:underline">
        {active?.name ?? "Seleccionar organización"}
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {orgs.map((org) => (
          <DropdownMenuItem
            key={org.id}
            onClick={async () => {
              await authClient.organization.setActive({ organizationId: org.id });
              await navigate({ to: "/app/branches" });
              window.location.reload();
            }}
          >
            {org.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AppLayout() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { data: session } = authClient.useSession();

  if (!session) {
    return <LoadingState className="m-8" />;
  }

  return (
    <AppShell
      items={navItems}
      LinkComponent={RouterLink}
      pathname={pathname}
      user={{ name: session.user.name, email: session.user.email }}
      brand={<span className="text-base font-semibold">odentIA</span>}
      topbarActions={<OrgSwitcher />}
      onSignOut={async () => {
        await authClient.signOut();
        await navigate({ to: "/login" });
      }}
    >
      <Outlet />
    </AppShell>
  );
}
