import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import {
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { Field, FieldError, FieldLabel, Input, toast } from "@odentia/ui";
import { Chip, ConfirmDialog, DataTable, EmptyState, ErrorState, FilterBar, FormDrawer, LoadingState, NewButton, PageHeader, RowActions, common, fieldErrorMessages, useListSearch } from "@odentia/ui-patterns";
import { Building2 } from "lucide-react";
import { useMemo, useState } from "react";
import { z } from "zod";
import { ApiError, apiFetch } from "../../lib/api";
import { authClient } from "../../lib/auth-client";

export const Route = createFileRoute("/app/branches")({
  component: BranchesPage,
});

interface Branch {
  id: string;
  name: string;
  addressLine1: string | null;
  district: string | null;
  phone: string | null;
  isActive: boolean;
}

const branchSchema = z.object({
  name: z.string().min(1, "Ingresa el nombre"),
  addressLine1: z.string(),
  district: z.string(),
  phone: z.string(),
});

type BranchFormValues = z.infer<typeof branchSchema>;

const emptyValues: BranchFormValues = { name: "", addressLine1: "", district: "", phone: "" };

function BranchesPage() {
  const queryClient = useQueryClient();
  const listSearch = useListSearch();
  const search = listSearch.get("search") ?? "";

  const { data: activeOrg } = useQuery({
    queryKey: ["active-org"],
    queryFn: async () => (await authClient.organization.getFullOrganization()).data,
  });

  const branchesQuery = useQuery({
    queryKey: ["branches"],
    queryFn: () => apiFetch<{ data: Branch[] }>("/api/branches"),
  });

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<Branch | null>(null);
  const [deactivating, setDeactivating] = useState<Branch | null>(null);

  const saveMutation = useMutation({
    mutationFn: async (values: BranchFormValues) => {
      const body = JSON.stringify({
        name: values.name,
        addressLine1: values.addressLine1 || undefined,
        district: values.district || undefined,
        phone: values.phone || undefined,
      });
      if (editing) {
        await apiFetch(`/api/branches/${editing.id}`, { method: "PATCH", body });
      } else {
        await apiFetch("/api/branches", { method: "POST", body });
      }
    },
    onSuccess: async () => {
      setDrawerOpen(false);
      setEditing(null);
      await queryClient.invalidateQueries({ queryKey: ["branches"] });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? (error.shape.message ?? error.message) : error.message);
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: (branch: Branch) => apiFetch(`/api/branches/${branch.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      setDeactivating(null);
      await queryClient.invalidateQueries({ queryKey: ["branches"] });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? (error.shape.message ?? error.message) : error.message);
    },
  });

  const form = useForm({
    defaultValues: emptyValues,
    validators: { onSubmit: branchSchema },
    onSubmit: async ({ value }) => {

      await saveMutation.mutateAsync(value);
    },
  });

  const canWrite = useCanWrite();

  const columns = useMemo<ColumnDef<Branch>[]>(
    () => [
      { accessorKey: "name", header: "Nombre" },
      {
        accessorKey: "addressLine1",
        header: "Dirección",
        cell: ({ getValue }) => getValue<string | null>() ?? "—",
      },
      {
        accessorKey: "district",
        header: "Distrito",
        cell: ({ getValue }) => getValue<string | null>() ?? "—",
      },
      {
        accessorKey: "isActive",
        header: "Estado",
        cell: ({ getValue }) => (
          <Chip variant={getValue<boolean>() ? "success" : "neutral"}>
            {getValue<boolean>() ? "Activa" : "Inactiva"}
          </Chip>
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) =>
          canWrite ? (
            <RowActions
              label={`Acciones de ${row.original.name}`}
              items={[
                {
                  key: "edit",
                  label: "Editar",
                  onSelect: () => {
                    setEditing(row.original);
                    form.reset();
                    form.setFieldValue("name", row.original.name);
                    form.setFieldValue("addressLine1", row.original.addressLine1 ?? "");
                    form.setFieldValue("district", row.original.district ?? "");
                    form.setFieldValue("phone", row.original.phone ?? "");
                    setDrawerOpen(true);
                  },
                },
                {
                  key: "deactivate",
                  label: "Desactivar",
                  tone: "danger",
                  disabled: !row.original.isActive,
                  onSelect: () => setDeactivating(row.original),
                },
              ]}
            />
          ) : null,
      },
    ],
    [canWrite, form],
  );

  const filtered = useMemo(() => {
    const rows = branchesQuery.data?.data ?? [];
    if (!search) return rows;
    const needle = search.toLowerCase();
    return rows.filter((row) => row.name.toLowerCase().includes(needle));
  }, [branchesQuery.data, search]);

  const table = useReactTable({
    data: filtered,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Sucursales"
        subtitle={activeOrg?.name}
        actions={
          canWrite ? (
            <NewButton
              label="Nueva sucursal"
              onClick={() => {
                setEditing(null);
                form.reset();
                setDrawerOpen(true);
              }}
            />
          ) : undefined
        }
      />
      <FilterBar filters={[]} sortOptions={[]} searchPlaceholder="Buscar sucursal" />

      {branchesQuery.isLoading ? (
        <LoadingState />
      ) : branchesQuery.isError ? (
        <ErrorState
          error={branchesQuery.error instanceof ApiError ? branchesQuery.error.shape : null}
          onRetry={() => void branchesQuery.refetch()}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={search ? common.filters.noResults : "Sin sucursales"}
          description={
            search
              ? `No hay sucursales que coincidan con “${search}”.`
              : "Registra tu primera sucursal para operar."
          }
        />
      ) : (
        <DataTable table={table} />
      )}

      <FormDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={editing ? `Editar ${editing.name}` : "Nueva sucursal"}
        isSubmitting={saveMutation.isPending}
        submitLabel={common.actions.save}
        cancelLabel={common.actions.cancel}
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <div className="flex flex-col gap-4">
          <form.Field name="name">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="branch-name">Nombre</FieldLabel>
                <Input
                  id="branch-name"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError>
                  {fieldErrorMessages(field.state.meta.errors)[0] ?? null}
                </FieldError>
              </Field>
            )}
          </form.Field>
          <form.Field name="addressLine1">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="branch-address">Dirección</FieldLabel>
                <Input
                  id="branch-address"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </Field>
            )}
          </form.Field>
          <form.Field name="district">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="branch-district">Distrito</FieldLabel>
                <Input
                  id="branch-district"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </Field>
            )}
          </form.Field>
          <form.Field name="phone">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="branch-phone">Teléfono</FieldLabel>
                <Input
                  id="branch-phone"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </Field>
            )}
          </form.Field>
        </div>
      </FormDrawer>

      <ConfirmDialog
        open={deactivating !== null}
        onClose={() => setDeactivating(null)}
        onConfirm={() => deactivating && deactivateMutation.mutate(deactivating)}
        title={`Desactivar ${deactivating?.name ?? ""}`}
        description="La sucursal dejará de estar operativa. Puedes reactivarla más adelante."
        confirmLabel="Desactivar"
        variant="destructive"
        pending={deactivateMutation.isPending}
      />
    </div>
  );
}

/** Rol del usuario en la org activa: owner/admin pueden escribir. */
function useCanWrite(): boolean {
  const { data } = useQuery({
    queryKey: ["my-role"],
    queryFn: async () => {
      const [session, active] = await Promise.all([
        authClient.getSession(),
        authClient.organization.getFullOrganization(),
      ]);
      const userId = session.data?.user.id;
      const me = active.data?.members.find((m) => m.userId === userId);
      return me?.role ?? "member";
    },
  });
  return data === "owner" || data === "admin";
}
