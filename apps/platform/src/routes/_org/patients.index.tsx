import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import {
  DataTable,
  EmptyState,
  FilterBar,
  NewButton,
  PageHeader,
  useListSearch,
} from "@odentia/ui-patterns";
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../lib/api";
import { timeAgo } from "../../lib/crm";
import { ageFrom, hcLabel, type Patient } from "../../lib/patients";

export const Route = createFileRoute("/_org/patients/")({
  component: PatientsPage,
});

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

function PatientsPage() {
  const navigate = useNavigate();
  const listSearch = useListSearch();
  const search = useDebounced(listSearch.get("search") ?? "", 300);

  const patientsQuery = useQuery({
    queryKey: ["patients", search],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search.trim()) params.set("q", search.trim());
      return apiFetch<{ data: Patient[]; nextCursor?: string | null }>(`/api/patients?${params}`);
    },
  });

  const columns = useMemo<ColumnDef<Patient>[]>(
    () => [
      {
        id: "hc",
        header: "HC",
        cell: ({ row }) => hcLabel(row.original.patientNumber),
      },
      {
        id: "displayName",
        header: "Nombre",
        cell: ({ row }) => (
          <Link
            to="/patients/$patientId"
            params={{ patientId: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.displayName ?? "—"}
          </Link>
        ),
      },
      {
        id: "document",
        header: "Documento",
        cell: ({ row }) =>
          row.original.docNumber ? (
            `${row.original.docType ?? ""} ${row.original.docNumber}`.trim()
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "age",
        header: "Edad",
        cell: ({ row }) => ageFrom(row.original.birthDate ?? null) || "—",
      },
      {
        accessorKey: "createdAt",
        header: "Registrado",
        cell: ({ row }) => timeAgo(row.original.createdAt),
      },
    ],
    [],
  );

  const table = useReactTable({
    data: patientsQuery.data?.data ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Pacientes"
        subtitle="Fichas clínicas de la organización"
        actions={
          <NewButton label="Nuevo paciente" onClick={() => navigate({ to: "/patients/new" })} />
        }
      />
      <FilterBar filters={[]} sortOptions={[]} searchPlaceholder="Buscar paciente" />
      {patientsQuery.data?.data.length === 0 && !patientsQuery.isLoading ? (
        <EmptyState title="Sin pacientes" description="Registra el primero con el botón Nuevo paciente." />
      ) : (
        <DataTable table={table} />
      )}
    </div>
  );
}
