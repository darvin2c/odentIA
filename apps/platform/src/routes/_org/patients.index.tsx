import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { getCoreRowModel, useReactTable, type ColumnDef, type SortingState } from "@tanstack/react-table";
import { Badge, Button } from "@odentia/ui";
import {
  DataTable,
  EmptyState,
  FilterBar,
  PageHeader,
  PageShell,
  useListSearch,
} from "@odentia/ui-patterns";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../lib/api";
import { timeAgo, useCanWrite } from "../../lib/crm";
import { ageFrom, hcLabel } from "../../lib/patients";
import { PATIENT_FILTERS, PATIENT_SORT_OPTIONS, type PatientListRow } from "../../lib/patient-overview";
import { CreatePatientDrawer } from "../../components/patient/create-patient-drawer";

const PAGE_LIMIT = 20;

export const Route = createFileRoute("/_org/patients/")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.contactId === "string" ? { contactId: search.contactId } : {}),
    ...(typeof search.q === "string" ? { q: search.q } : {}),
    ...(typeof search.isActive === "string" ? { isActive: search.isActive } : {}),
    ...(typeof search.sex === "string" ? { sex: search.sex } : {}),
    ...(typeof search.docType === "string" ? { docType: search.docType } : {}),
    ...(typeof search.sort === "string" ? { sort: search.sort } : {}),
    ...(typeof search.cursor === "string" ? { cursor: search.cursor } : {}),
  }),
  component: PatientsPage,
});


function PatientsPage() {
  const navigate = useNavigate();
  const canWrite = useCanWrite();
  const { contactId } = Route.useSearch();
  const [creating, setCreating] = useState(false);
  const listSearch = useListSearch();
  const search = listSearch.get("q") ?? "";
  const isActive = listSearch.get("isActive");
  const sex = listSearch.get("sex");
  const docType = listSearch.get("docType");
  const sort = listSearch.get("sort");
  const cursor = listSearch.get("cursor");
  const [previousCursors, setPreviousCursors] = useState<string[]>([]);

  useEffect(() => {
    if (!cursor) setPreviousCursors([]);
  }, [cursor]);

  const patientsQuery = useQuery({
    queryKey: ["patients", search, isActive, sex, docType, sort, cursor],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_LIMIT));
      if (search.trim()) params.set("q", search.trim());
      if (isActive) params.set("isActive", isActive);
      if (sex) params.set("sex", sex);
      if (docType) params.set("docType", docType);
      if (sort) params.set("sort", sort);
      if (cursor) params.set("cursor", cursor);
      return apiFetch<{ data: PatientListRow[]; nextCursor?: string | null }>(`/api/patients?${params}`);
    },
  });

  const columns = useMemo<ColumnDef<PatientListRow>[]>(
    () => [
      {
        accessorKey: "patientNumber",
        id: "number",
        header: "HC",
        cell: ({ row }) => hcLabel(row.original.patientNumber),
      },
      {
        accessorKey: "displayName",
        id: "name",
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
        id: "phone",
        header: "Teléfono",
        cell: ({ row }) =>
          row.original.phone ?? <span className="text-muted-foreground">—</span>,
      },
      {
        id: "status",
        header: "Estado",
        cell: ({ row }) => (
          <Badge variant={row.original.isActive ? "secondary" : "outline"}>
            {row.original.isActive ? "Activo" : "Inactivo"}
          </Badge>
        ),
      },
      {
        accessorKey: "createdAt",
        id: "created",
        header: "Registrado",
        cell: ({ row }) => timeAgo(row.original.createdAt),
      },
    ],
    [],
  );

  const rows = patientsQuery.data?.data ?? [];
  const nextCursor = patientsQuery.data?.nextCursor ?? null;
  const pageNumber = previousCursors.length + 1;
  const hasActiveFilter = Boolean(search || isActive || sex || docType);
  const currentSort = sort ?? "-created";
  const sorting: SortingState = [{ id: currentSort.replace(/^-/, ""), desc: currentSort.startsWith("-") }];

  const table = useReactTable({
    data: rows,
    columns,
    manualSorting: true,
    enableSortingRemoval: false,
    state: { sorting },
    onSortingChange: (updater) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      const first = next[0];
      if (first) listSearch.setParam("sort", `${first.desc ? "-" : ""}${first.id}`);
    },
    getCoreRowModel: getCoreRowModel(),
  });

  const goNext = () => {
    if (!nextCursor) return;
    setPreviousCursors((stack) => [...stack, cursor ?? ""]);
    listSearch.setParam("cursor", nextCursor);
  };
  const goPrevious = () => {
    const copy = [...previousCursors];
    const previous = copy.pop();
    setPreviousCursors(copy);
    listSearch.setParam("cursor", previous || undefined);
  };

  return (
    <PageShell>
      <PageHeader
        title="Pacientes"
        subtitle="Fichas clínicas de la organización"
        actions={canWrite &&
          <Button
            type="button"
            onClick={() => setCreating(true)}
          >
            <Plus aria-hidden />
            Nuevo paciente
          </Button>
        }
      />
      <div className="py-4">
        <FilterBar
          filters={PATIENT_FILTERS}
          sortOptions={PATIENT_SORT_OPTIONS}
          searchPlaceholder="Buscar por nombre, documento, teléfono o correo"
        />
      </div>
      {patientsQuery.isPending ? (
        <p className="text-sm text-muted-foreground">Cargando pacientes…</p>
      ) : patientsQuery.isError ? (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-destructive">{patientsQuery.error.message}</p>
          <div>
            <Button type="button" variant="outline" onClick={() => void patientsQuery.refetch()}>
              Reintentar
            </Button>
          </div>
        </div>
      ) : rows.length === 0 ? (
        hasActiveFilter ? (
          <EmptyState
            title="Sin pacientes para los filtros seleccionados"
            description="Ajusta la búsqueda o limpia los filtros para ver todo el padrón."
          />
        ) : (
          <EmptyState title="Sin pacientes" description="Registra el primero con el botón Nuevo paciente." />
        )
      ) : (
        <>
          <DataTable table={table} />
          <div className="flex flex-wrap items-center justify-between gap-2 py-2">
            <p className="text-xs text-muted-foreground">
              Página {pageNumber} · {rows.length} paciente(s)
              {nextCursor ? " · hay más resultados" : " · fin del listado"}
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={previousCursors.length === 0 || patientsQuery.isFetching}
                onClick={goPrevious}
              >
                Anterior
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!nextCursor || patientsQuery.isFetching}
                onClick={goNext}
              >
                {patientsQuery.isFetching ? "Cargando…" : "Siguiente"}
              </Button>
            </div>
          </div>
        </>
      )}
      {canWrite && (creating || contactId) && (
        <CreatePatientDrawer
          key={contactId ?? "new"}
          open
          contactId={contactId}
          onClose={() => {
            setCreating(false);
            if (contactId) void navigate({
              to: "/patients",
              replace: true,
              search: (previous) => ({ ...previous, contactId: undefined }),
            });
          }}
        />
      )}
    </PageShell>
  );
}
