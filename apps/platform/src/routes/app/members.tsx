import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import {
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { Button, Field, FieldError, FieldLabel, Input, toast } from "@odentia/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@odentia/ui";
import { Chip, ConfirmDialog, DataTable, EmptyState, ErrorState, FormDrawer, LoadingState, NewButton, PageHeader, RowActions, common, fieldErrorMessages } from "@odentia/ui-patterns";
import { useMemo, useState } from "react";
import { z } from "zod";
import { authClient } from "../../lib/auth-client";

export const Route = createFileRoute("/app/members")({
  component: MembersPage,
});

interface FullOrganization {
  id: string;
  name: string;
  members: { id: string; userId: string; role: string; user: { email: string; name: string } }[];
  invitations: { id: string; email: string; role: string; status: string }[];
}

const inviteSchema = z.object({
  email: z.string().email("Correo inválido"),
  role: z.enum(["member", "admin"]),
});

function MembersPage() {
  const queryClient = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [removing, setRemoving] = useState<{ id: string; label: string } | null>(null);

  const orgQuery = useQuery({
    queryKey: ["full-org"],
    queryFn: async () =>
      (await authClient.organization.getFullOrganization()).data as FullOrganization | null,
  });

  const sessionQuery = useQuery({
    queryKey: ["session"],
    queryFn: async () => (await authClient.getSession()).data,
  });

  const myRole =
    orgQuery.data?.members.find((m) => m.userId === sessionQuery.data?.user.id)?.role ?? "member";
  const canWrite = myRole === "owner" || myRole === "admin";

  const inviteMutation = useMutation({
    mutationFn: async (values: z.infer<typeof inviteSchema>) => {
      const { error: inviteError } = await authClient.organization.inviteMember({
        email: values.email,
        role: values.role,
      });
      if (inviteError) throw new Error(inviteError.message ?? "No se pudo invitar.");
    },
    onSuccess: async () => {
      setInviteOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["full-org"] });
    },
    onError: (cause) => toast.error(cause.message),
  });

  const form = useForm({
    defaultValues: { email: "", role: "member" as "member" | "admin" },
    validators: { onSubmit: inviteSchema },
    onSubmit: async ({ value, formApi }) => {
      await inviteMutation.mutateAsync(value);
      formApi.reset();
    },
  });

  const roleMutation = useMutation({
    mutationFn: async ({ memberId, role }: { memberId: string; role: string }) => {
      const { error: roleError } = await authClient.organization.updateMemberRole({
        memberId,
        role: role as "member" | "admin",
      });
      if (roleError) throw new Error(roleError.message ?? "No se pudo cambiar el rol.");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["full-org"] }),
    onError: (cause) => toast.error(cause.message),
  });

  const removeMutation = useMutation({
    mutationFn: async (memberIdOrEmail: string) => {
      const { error: removeError } = await authClient.organization.removeMember({
        memberIdOrEmail,
      });
      if (removeError) throw new Error(removeError.message ?? "No se pudo revocar.");
    },
    onSuccess: async () => {
      setRemoving(null);
      await queryClient.invalidateQueries({ queryKey: ["full-org"] });
    },
    onError: (cause) => toast.error(cause.message),
  });

  const cancelInvitationMutation = useMutation({
    mutationFn: async (invitationId: string) => {
      const { error: cancelError } = await authClient.organization.cancelInvitation({
        invitationId,
      });
      if (cancelError) throw new Error(cancelError.message ?? "No se pudo revocar la invitación.");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["full-org"] }),
    onError: (cause) => toast.error(cause.message),
  });

  const org = orgQuery.data;

  type Membership = NonNullable<typeof org>["members"][number];

  const columns = useMemo<ColumnDef<Membership>[]>(
    () => [
      {
        accessorKey: "user.name",
        header: "Nombre",
        cell: ({ row }) => row.original.user.name,
      },
      {
        accessorKey: "user.email",
        header: "Correo",
        cell: ({ row }) => row.original.user.email,
      },
      {
        accessorKey: "role",
        header: "Rol",
        cell: ({ row }) => (
          <Chip variant={row.original.role === "owner" ? "success" : "neutral"}>
            {row.original.role}
          </Chip>
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const membership = row.original;
          if (!canWrite || membership.role === "owner") return null;
          return (
            <div className="text-right">
              <RowActions
                label={`Acciones de ${membership.user.name}`}
                items={[
                  {
                    key: "role",
                    label: membership.role === "admin" ? "Bajar a member" : "Subir a admin",
                    onSelect: () =>
                      roleMutation.mutate({
                        memberId: membership.id,
                        role: membership.role === "admin" ? "member" : "admin",
                      }),
                  },
                  {
                    key: "remove",
                    label: "Revocar acceso",
                    tone: "danger",
                    onSelect: () =>
                      setRemoving({ id: membership.id, label: membership.user.email }),
                  },
                ]}
              />
            </div>
          );
        },
      },
    ],
    [canWrite, roleMutation],
  );

  const table = useReactTable({
    data: org?.members ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Miembros"
        subtitle={org?.name}
        actions={
          canWrite ? (
            <NewButton
              label="Invitar miembro"
              onClick={() => {
                form.reset();
                setInviteOpen(true);
              }}
            />
          ) : undefined
        }
      />

      <FormDrawer
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title="Invitar miembro"
        description={org?.name}
        isSubmitting={inviteMutation.isPending}
        submitLabel="Invitar"
        cancelLabel={common.actions.cancel}
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.Field name="email">
          {(field) => (
            <Field>
              <FieldLabel htmlFor="invite-email">Invitar por correo</FieldLabel>
              <Input
                id="invite-email"
                type="email"
                placeholder="colega@clinica.pe"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              <FieldError>
                {fieldErrorMessages(field.state.meta.errors)[0] ?? null}
              </FieldError>
            </Field>
          )}
        </form.Field>
        <form.Field name="role">
          {(field) => (
            <Field>
              <FieldLabel>Rol</FieldLabel>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button type="button" variant="outline">
                      Rol: {field.state.value === "admin" ? "admin" : "member"}
                    </Button>
                  }
                />
                <DropdownMenuContent>
                  <DropdownMenuItem onClick={() => field.handleChange("member")}>
                    member
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => field.handleChange("admin")}>
                    admin
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </Field>
          )}
        </form.Field>
      </FormDrawer>

      {orgQuery.isLoading ? (
        <LoadingState />
      ) : orgQuery.isError ? (
        <ErrorState message="No se pudo cargar la organización." onRetry={() => void orgQuery.refetch()} />
      ) : !org ? (
        <EmptyState title="Sin organización activa" />
      ) : (
        <>
          <DataTable table={table} />

          {org.invitations.filter((inv) => inv.status === "pending").length > 0 ? (
            <div className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">Invitaciones pendientes</h2>
              {org.invitations
                .filter((inv) => inv.status === "pending")
                .map((inv) => (
                  <div
                    key={inv.id}
                    className="flex items-center justify-between rounded-lg border border-border p-3 text-sm"
                  >
                    <span>
                      {inv.email} <Chip>{inv.role}</Chip>
                    </span>
                    {canWrite ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => cancelInvitationMutation.mutate(inv.id)}
                      >
                        Revocar
                      </Button>
                    ) : null}
                  </div>
                ))}
            </div>
          ) : null}
        </>
      )}

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && removeMutation.mutate(removing.id)}
        title={`Revocar acceso de ${removing?.label ?? ""}`}
        description="El miembro perderá acceso a esta organización."
        confirmLabel="Revocar"
        cancelLabel={common.actions.cancel}
        variant="destructive"
        pending={removeMutation.isPending}
      />
    </div>
  );
}
