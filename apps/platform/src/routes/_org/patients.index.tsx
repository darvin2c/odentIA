import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { Field, FieldError, FieldLabel, Input } from "@odentia/ui";
import {
  DataTable,
  EmptyState,
  FilterBar,
  FormDrawer,
  NewButton,
  PageHeader,
  fieldErrorMessages,
  useListSearch,
} from "@odentia/ui-patterns";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { apiFetch } from "../../lib/api";
import { timeAgo } from "../../lib/crm";
import { ageFrom, hcLabel, type Patient } from "../../lib/patients";

export const Route = createFileRoute("/_org/patients/")({
  component: PatientsPage,
});

const orgRouteApi = getRouteApi("/_org");

const patientSchema = z.object({
  displayName: z.string().min(1, "Ingresa el nombre"),
  docType: z.string().optional(),
  docNumber: z.string().max(20).optional(),
  birthDate: z.string().optional(),
  sex: z.string().optional(),
});

type PatientFormValues = z.infer<typeof patientSchema>;

const emptyValues: PatientFormValues = {
  displayName: "",
  docType: "",
  docNumber: "",
  birthDate: "",
  sex: "",
};

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

function PatientsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  void orgRouteApi.useRouteContext();
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

  const [drawerOpen, setDrawerOpen] = useState(false);

  const saveMutation = useMutation({
    mutationFn: async (values: PatientFormValues) => {
      const body: Record<string, unknown> = { displayName: values.displayName };
      if (values.docType) body.docType = values.docType;
      if (values.docNumber) body.docNumber = values.docNumber;
      if (values.birthDate) body.birthDate = values.birthDate;
      if (values.sex) body.sex = values.sex;
      const created = await apiFetch<{ data: Patient }>("/api/patients", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return created.data;
    },
    onSuccess: (created) => {
      setDrawerOpen(false);
      form.reset();
      void queryClient.invalidateQueries({ queryKey: ["patients"] });
      void navigate({ to: "/patients/$patientId", params: { patientId: created.id } });
    },
  });

  const form = useForm({
    defaultValues: emptyValues,
    validators: { onSubmit: patientSchema },
    onSubmit: ({ value }) => saveMutation.mutate(value),
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
        actions={<NewButton label="Nuevo paciente" onClick={() => setDrawerOpen(true)} />}
      />
      <FilterBar filters={[]} sortOptions={[]} searchPlaceholder="Buscar paciente" />
      {patientsQuery.data?.data.length === 0 && !patientsQuery.isLoading ? (
        <EmptyState title="Sin pacientes" description="Registra el primero con el botón Nuevo paciente." />
      ) : (
        <DataTable table={table} />
      )}
      <FormDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Nuevo paciente"
        submitLabel="Crear"
        cancelLabel="Cancelar"
        isSubmitting={saveMutation.isPending}
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <div className="flex flex-col gap-4">
          <form.Field name="displayName">
            {(field) => (
              <Field>
                <FieldLabel>Nombre</FieldLabel>
                <Input value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} />
                <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
              </Field>
            )}
          </form.Field>
          <form.Field name="docType">
            {(field) => (
              <Field>
                <FieldLabel>Tipo de documento (opcional)</FieldLabel>
                <select
                  aria-label="Tipo de documento"
                  className="rounded-md border bg-background px-2 py-1.5 text-sm"
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                >
                  <option value="">—</option>
                  <option value="DNI">DNI</option>
                  <option value="CE">CE</option>
                  <option value="PASAPORTE">Pasaporte</option>
                  <option value="OTRO">Otro</option>
                </select>
                <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
              </Field>
            )}
          </form.Field>
          <form.Field name="docNumber">
            {(field) => (
              <Field>
                <FieldLabel>Número de documento (opcional)</FieldLabel>
                <Input value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} />
                <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
              </Field>
            )}
          </form.Field>
          <form.Field name="birthDate">
            {(field) => (
              <Field>
                <FieldLabel>Fecha de nacimiento (opcional)</FieldLabel>
                <Input
                  type="date"
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
                <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
              </Field>
            )}
          </form.Field>
          <form.Field name="sex">
            {(field) => (
              <Field>
                <FieldLabel>Sexo (opcional)</FieldLabel>
                <select
                  aria-label="Sexo"
                  className="rounded-md border bg-background px-2 py-1.5 text-sm"
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                >
                  <option value="">—</option>
                  <option value="M">Masculino</option>
                  <option value="F">Femenino</option>
                </select>
                <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
              </Field>
            )}
          </form.Field>
        </div>
      </FormDrawer>
    </div>
  );
}
