import { useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  getRouteApi,
  Link,
  Outlet,
  redirect,
  useRouterState,
} from "@tanstack/react-router";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@odentia/ui";
import { AppShell, LoadingState, type AppShellNavEntry } from "@odentia/ui-patterns";
import { Bot, Building2, Contact, FlaskConical, Inbox, Kanban, ListTodo, MessageCircle, Settings, Smile, Tag, Users } from "lucide-react";
import { authClient } from "../lib/auth-client";
import { requireVerifiedSession, ssrFetchOptions } from "../lib/guards";
import { orgSlugFromHostname, panelUrl, requestHostname, tenantUrl } from "../lib/host";

export const Route = createFileRoute("/_org")({
  beforeLoad: async ({ location }) => {
    const session = await requireVerifiedSession(location);
    const slug = orgSlugFromHostname(requestHostname());
    if (!slug) {
      throw redirect({ href: panelUrl("/") });
    }
    const fetchOptions = ssrFetchOptions();
    const { data } = await authClient.organization.getFullOrganization({
      query: { organizationSlug: slug },
      fetchOptions,
    });
    if (!data) {
      const { data: orgs } = await authClient.organization.list({ fetchOptions });
      throw redirect({ href: panelUrl(orgs && orgs.length > 0 ? "/" : "/onboarding") });
    }
    return { session, org: data };
  },
  component: OrgLayout,
});

const navItems: AppShellNavEntry[] = [
  { label: "Bandeja", to: "/inbox", icon: Inbox },
  { label: "Contactos", to: "/contacts", icon: Contact },
  { label: "Pacientes", to: "/patients", icon: Smile },
  { label: "Pipeline", to: "/pipeline", icon: Kanban },
  { label: "Tareas", to: "/tasks", icon: ListTodo },
  {
    label: "Configuración",
    icon: Settings,
    children: [
      { label: "Canales", to: "/settings/channels", icon: MessageCircle },
      { label: "Agente", to: "/settings/agent", icon: Bot },
      { label: "Pipelines", to: "/settings/pipelines", icon: Kanban },
      { label: "Campos", to: "/settings/fields", icon: Tag },
    ],
  },
  { label: "Sucursales", to: "/branches", icon: Building2 },
  { label: "Miembros", to: "/members", icon: Users },
  { label: "Demo", to: "/demo", icon: FlaskConical },
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

const orgRouteApi = getRouteApi("/_org");

function OrgSwitcher() {
  const { org } = orgRouteApi.useRouteContext();
  const { data: orgs } = useQuery({
    queryKey: ["orgs"],
    queryFn: async () => (await authClient.organization.list()).data ?? [],
  });

  if (!orgs || orgs.length <= 1) {
    return <span className="text-sm font-medium">{org.name}</span>;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="text-sm font-medium underline-offset-2 hover:underline">
        {org.name}
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {orgs.map((item) => (
          <DropdownMenuItem
            key={item.id}
            onClick={() => window.location.assign(tenantUrl(item.slug, "/branches"))}
          >
            {item.name}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onClick={() => window.location.assign(panelUrl("/"))}>
          Todas las organizaciones
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function OrgLayout() {
  const { org, session } = orgRouteApi.useRouteContext();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  if (!session) {
    return <LoadingState className="m-8" />;
  }

  return (
    <AppShell
      items={navItems}
      LinkComponent={RouterLink}
      pathname={pathname}
      user={{ name: session.name, email: session.email }}
      brand={<span className="text-base font-semibold">odentIA</span>}
      topbarActions={<OrgSwitcher />}
      onSignOut={async () => {
        await authClient.signOut();
        window.location.assign(panelUrl("/login"));
      }}
    >
      <Outlet />
    </AppShell>
  );
}
