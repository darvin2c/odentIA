import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Field,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "@odentia/ui";
import { ConfirmDialog, EmptyState, FormDrawer, SubmitButton } from "@odentia/ui-patterns";
import { useId, useState } from "react";
import { ApiError, apiFetch } from "../../lib/api";
import { useCanWrite } from "../../lib/crm";
import {
  FDI_ADULT,
  FDI_CHILD,
  planStatusLabel,
  type PlanItem,
} from "../../lib/patients";
import { Cie10Search } from "./cie10-search";

const NO_TOOTH = "__sin-pieza__";

type PlanStatus = "pendiente" | "programado" | "realizado" | "cancelado";

const OPEN_STATUSES: readonly string[] = ["pendiente", "programado"];

/** Moneda para mostrar: nunca se reetiqueta (USD no es S/). */
function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("es-PE", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
}

/**
 * Convierte un monto decimal en soles/unidades (ej. "150.50", "150,50") a
 * centavos enteros. Vacío = sin precio (null), nunca 0.
 */
function parsePriceToCents(raw: string): { ok: true; cents: number | null } | { ok: false } {
  const text = raw.trim().replace(",", ".");
  if (text === "") return { ok: true, cents: null };
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(text)) return { ok: false };
  const cents = Math.round(Number(text) * 100);
  if (!Number.isFinite(cents) || cents < 0 || cents > 2147483647) return { ok: false };
  return { ok: true, cents };
}

function mutationMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.shape.code === "ITEM_CLOSED") {
      return "El ítem está cerrado (realizado o cancelado) y ya no se puede editar.";
    }
    if (err.shape.message) return err.shape.message;
  }
  return err instanceof Error ? err.message : "No se pudo guardar. Inténtalo de nuevo.";
}

export function PlanTab({ patientId }: { patientId: string }): React.JSX.Element {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();
  const uid = useId();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PlanItem | null>(null);
  const [toothSel, setToothSel] = useState<string>(NO_TOOTH);
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [price, setPrice] = useState("");
  const [cie, setCie] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<PlanItem | null>(null);

  const planQuery = useQuery({
    queryKey: ["plan", patientId],
    queryFn: () => apiFetch<{ data: PlanItem[] }>(`/api/patients/${patientId}/plan`),
  });

  const refreshPlan = () => {
    void queryClient.invalidateQueries({ queryKey: ["plan", patientId] });
    void queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] });
  };

  const saveMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      editing
        ? apiFetch<{ data: PlanItem }>(`/api/patients/${patientId}/plan/items/${editing.id}`, {
            method: "PATCH",
            body: JSON.stringify(body),
          })
        : apiFetch<{ data: PlanItem }>(`/api/patients/${patientId}/plan/items`, {
            method: "POST",
            body: JSON.stringify(body),
          }),
    onSuccess: () => {
      refreshPlan();
      setDialogOpen(false);
      setFormError(null);
    },
    onError: (err) => setFormError(mutationMessage(err)),
  });

  const statusMutation = useMutation({
    mutationFn: ({ item, status }: { item: PlanItem; status: PlanStatus }) =>
      apiFetch<{ data: PlanItem }>(`/api/patients/${patientId}/plan/items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }).then(() => item),
    onSuccess: (item) => {
      refreshPlan();
      // La ficha solo cambia si el ítem está vinculado a una atención.
      if (item.encounterId) {
        void queryClient.invalidateQueries({ queryKey: ["patient", patientId] });
      }
      setActionError(null);
      setCancelling(null);
    },
    onError: (err) => {
      setActionError(mutationMessage(err));
      setCancelling(null);
    },
  });

  const openNew = () => {
    setEditing(null);
    setToothSel(NO_TOOTH);
    setTitle("");
    setDetail("");
    setPrice("");
    setCie("");
    setFormError(null);
    setDialogOpen(true);
  };

  const openEdit = (item: PlanItem) => {
    setEditing(item);
    setToothSel(item.toothNumber == null ? NO_TOOTH : String(item.toothNumber));
    setTitle(item.title);
    setDetail(item.detail ?? "");
    setPrice(item.priceCents == null ? "" : (item.priceCents / 100).toFixed(2));
    setCie(item.diagnosisCode ?? "");
    setFormError(null);
    setDialogOpen(true);
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parsePriceToCents(price);
    if (!parsed.ok) {
      setFormError("Monto inválido. Usa un número con hasta 2 decimales (ej. 150.50) o déjalo vacío.");
      return;
    }
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setFormError("El título es obligatorio.");
      return;
    }
    const toothNumber = toothSel === NO_TOOTH ? null : Number(toothSel);
    const body: Record<string, unknown> = {
      title: trimmedTitle,
      detail: detail.trim() === "" ? null : detail.trim(),
      toothNumber,
      diagnosisCode: cie.trim() === "" ? null : cie.trim(),
      priceCents: parsed.cents,
    };
    // La moneda se fija al crear (PEN) y luego se congela: en edición se
    // conserva la existente y nunca se reenvía.
    if (!editing) body.currency = "PEN";
    saveMutation.mutate(body);
  };

  const items = planQuery.data?.data ?? [];
  const pending = items.filter((item) => OPEN_STATUSES.includes(item.status));
  const totalsByCurrency: Record<string, { withPrice: number; withoutPrice: number; totalCents: number }> = {};
  for (const item of pending) {
    const entry = totalsByCurrency[item.currency] ?? { withPrice: 0, withoutPrice: 0, totalCents: 0 };
    if (item.priceCents == null) {
      entry.withoutPrice += 1;
    } else {
      entry.withPrice += 1;
      entry.totalCents += item.priceCents;
    }
    totalsByCurrency[item.currency] = entry;
  }
  const totals = Object.entries(totalsByCurrency).sort(([a], [b]) => a.localeCompare(b));

  const toothItems: Record<string, string> = { [NO_TOOTH]: "Sin pieza" };
  for (const n of [...FDI_ADULT, ...FDI_CHILD]) toothItems[String(n)] = `Pieza ${n}`;

  const statusPending = statusMutation.isPending;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Plan de tratamiento</h2>
        {canWrite && (
          <Button size="sm" onClick={openNew}>
            Nuevo ítem
          </Button>
        )}
      </div>

      <section aria-label="Pendiente del plan" className="flex flex-col gap-1 rounded-lg border p-4">
        <h3 className="text-sm font-semibold">Pendiente</h3>
        {pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin ítems pendientes.</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {pending.length} ítem{pending.length === 1 ? "" : "s"} pendiente{pending.length === 1 ? "" : "s"}.
            </p>
            {totals.map(([currency, entry]) => (
              <p key={currency} className="text-sm">
                <span className="font-medium">{formatMoney(entry.totalCents, currency)}</span>
                {entry.withoutPrice > 0 && (
                  <span className="text-muted-foreground">
                    {" "}
                    · {entry.withoutPrice} sin precio definido
                  </span>
                )}
              </p>
            ))}
          </>
        )}
      </section>

      {actionError && (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      )}

      {planQuery.isLoading && <p className="text-sm text-muted-foreground">Cargando plan…</p>}
      {planQuery.isError && (
        <div className="flex flex-col gap-2 rounded-lg border p-4">
          <p className="text-sm text-destructive">No se pudo cargar el plan de tratamiento.</p>
          <Button size="sm" variant="outline" className="self-start" onClick={() => void planQuery.refetch()}>
            Reintentar
          </Button>
        </div>
      )}
      {planQuery.data && items.length === 0 && (
        <EmptyState title="Sin ítems en el plan" description="Registra el primer tratamiento propuesto para este paciente." />
      )}
      {items.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Pieza</TableHead>
              <TableHead>Tratamiento</TableHead>
              <TableHead>Diagnóstico</TableHead>
              <TableHead>Precio</TableHead>
              <TableHead>Estado</TableHead>
              {canWrite && (
                <TableHead>
                  <span className="sr-only">Acciones</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="whitespace-nowrap">
                    {item.toothNumber == null ? <span className="text-muted-foreground">—</span> : `Pieza ${item.toothNumber}`}
                  </TableCell>
                  <TableCell>
                    <p className="font-medium">{item.title}</p>
                    {item.detail && <p className="text-xs whitespace-pre-wrap text-muted-foreground">{item.detail}</p>}
                    {item.encounterId && (
                      <p className="text-xs text-muted-foreground">Vinculado a una atención.</p>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {item.diagnosisCode ? <Badge>{item.diagnosisCode}</Badge> : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {item.priceCents == null ? (
                      <span className="text-muted-foreground">Por definir</span>
                    ) : (
                      formatMoney(item.priceCents, item.currency)
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <Badge>{planStatusLabel(item.status)}</Badge>
                  </TableCell>
                  {canWrite && (
                    <TableCell>
                      {OPEN_STATUSES.includes(item.status) ? (
                        <div className="flex flex-wrap gap-1">
                          {item.status === "pendiente" && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={statusPending}
                              onClick={() => statusMutation.mutate({ item, status: "programado" })}
                            >
                              Programar
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={statusPending}
                            onClick={() => statusMutation.mutate({ item, status: "realizado" })}
                          >
                            Marcar realizado
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={statusPending}
                            onClick={() => setCancelling(item)}
                          >
                            Cancelar
                          </Button>
                          <Button size="sm" variant="outline" disabled={statusPending} onClick={() => openEdit(item)}>
                            Editar
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">Cerrado</span>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
          </TableBody>
        </Table>
      )}

      <FormDrawer
        open={dialogOpen}
        onClose={() => {
          if (!saveMutation.isPending) setDialogOpen(false);
        }}
        title={editing ? "Editar ítem del plan" : "Nuevo ítem del plan"}
        description={
          editing
            ? `La moneda (${editing.currency}) se conserva y no se puede cambiar.`
            : "La moneda inicial es soles (PEN)."
        }
        onSubmit={onSubmit}
        isSubmitting={saveMutation.isPending}
        submitLabel={editing ? "Guardar cambios" : "Agregar al plan"}
        error={formError}
      >
        <div className="flex flex-col gap-3">
          <Field>
            <FieldLabel htmlFor={uid + "-pieza"}>Pieza (FDI)</FieldLabel>
            <Select
              value={toothSel}
              items={toothItems}
              onValueChange={(v) => setToothSel(v ?? NO_TOOTH)}
              disabled={saveMutation.isPending}
            >
              <SelectTrigger id={uid + "-pieza"} aria-label="Pieza (FDI)">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_TOOTH}>Sin pieza</SelectItem>
                <SelectGroup>
                  <SelectLabel>Permanentes</SelectLabel>
                  {FDI_ADULT.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      Pieza {n}
                    </SelectItem>
                  ))}
                </SelectGroup>
                <SelectGroup>
                  <SelectLabel>Temporales</SelectLabel>
                  {FDI_CHILD.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      Pieza {n}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor={uid + "-titulo"}>Título</FieldLabel>
            <Input
              id={uid + "-titulo"}
              value={title}
              onChange={(e) => setTitle(e.currentTarget.value)}
              placeholder="p. ej. Corona cerámica"
              maxLength={300}
              required
              disabled={saveMutation.isPending}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={uid + "-detalle"}>Detalle</FieldLabel>
            <Textarea
              id={uid + "-detalle"}
              value={detail}
              onChange={(e) => setDetail(e.currentTarget.value)}
              placeholder="Detalle del tratamiento propuesto"
              rows={3}
              maxLength={4000}
              disabled={saveMutation.isPending}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={uid + "-precio"}>
              Precio ({editing ? editing.currency : "PEN"})
            </FieldLabel>
            <Input
              id={uid + "-precio"}
              value={price}
              onChange={(e) => setPrice(e.currentTarget.value)}
              placeholder="150.50"
              inputMode="decimal"
              disabled={saveMutation.isPending}
            />
            <p className="text-xs text-muted-foreground">
              Monto en {editing ? editing.currency : "soles (PEN)"}. Vacío = por definir.
            </p>
          </Field>
          <Cie10Search
            value={cie}
            onChange={(code) => setCie(code)}
            label="Diagnóstico CIE-10"
            disabled={saveMutation.isPending}
          />
        </div>
      </FormDrawer>

      <ConfirmDialog
        open={cancelling != null}
        title="Cancelar ítem"
        description={
          cancelling
            ? `Se cancelará «${cancelling.title}». Ya no se podrá editar ni programar.`
            : "Se cancelará este ítem."
        }
        confirmLabel="Cancelar ítem"
        variant="default"
        pending={statusMutation.isPending}
        onConfirm={() => {
          if (cancelling) statusMutation.mutate({ item: cancelling, status: "cancelado" });
        }}
        onClose={() => {
          if (!statusMutation.isPending) setCancelling(null);
        }}
      />
    </div>
  );
}
