import { formatMoney } from "@odentia/clinical"
import { Badge, Button, Field, FieldLabel, Input, Textarea } from "@odentia/ui"
import { EmptyState, FormDrawer } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import {
  useMemberName,
  useMyUserId,
  useOrgMembers,
  usePermission,
} from "../../lib/crm"
import { financeErrorMessage } from "../../lib/finance"
import { useOrgProfile } from "../../lib/org"
import { ChoiceSelect } from "../ui/choice-select"
import {
  fetchCommissionRates,
  fetchCommissionSettlementDetail,
  fetchCommissionSettlements,
  fetchMonthlyCommissions,
  fetchMyCommissions,
  payCommissionSettlementApi,
  rateBpsFromPercent,
  setCommissionRateApi,
  settleMonthCommissionsApi,
  voidCommissionSettlementApi,
} from "../../lib/commissions"

function currentYearMonth(timezone: string | undefined): { year: string; month: string } {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
    }).formatToParts(new Date())
    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? ""
    return { year: get("year"), month: get("month") }
  } catch {
    const now = new Date()
    return { year: String(now.getFullYear()), month: String(now.getMonth() + 1).padStart(2, "0") }
  }
}

function monthLabel(year: number, month: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  )
}

/**
 * Comisiones del profesional (Fase 8). Extraíble: Finanzas la monta en la
 * ruta /commissions. Con `ownOnly`, el profesional ve solo las suyas sin
 * tasa editable ni acciones de administración (el servidor lo refuerza).
 */
export function CommissionsPanel({
  professionalUserId,
  ownOnly = false,
  initialSettlementId = null,
}: {
  professionalUserId?: string
  ownOnly?: boolean
  initialSettlementId?: string | null
}) {
  const queryClient = useQueryClient()
  const canWrite = usePermission("commissions.write")
  const myUserId = useMyUserId()
  const members = useOrgMembers()
  const memberName = useMemberName()
  const profile = useOrgProfile()
  const adminMode = !ownOnly && canWrite
  const fallbackProfessional = professionalUserId ?? (ownOnly ? myUserId : "")
  const [selectedProfessional, setSelectedProfessional] = useState(fallbackProfessional)
  const professional = adminMode ? selectedProfessional : fallbackProfessional
  const now = currentYearMonth(profile.data?.timezone)
  const [year, setYear] = useState(now.year)
  const [month, setMonth] = useState(now.month)
  const [currency, setCurrency] = useState(profile.data?.currency ?? "")
  const [currencyTouched, setCurrencyTouched] = useState(false)
  useEffect(() => {
    if (!currencyTouched && profile.data?.currency) setCurrency(profile.data.currency)
  }, [profile.data?.currency, currencyTouched])
  const [rate, setRate] = useState("")
  const [notes, setNotes] = useState("")
  const [branchId, setBranchId] = useState("")
  const [settlementId, setSettlementId] = useState<string | null>(initialSettlementId)
  const [confirmPay, setConfirmPay] = useState(false)
  const [confirmVoid, setConfirmVoid] = useState(false)
  const [voidReason, setVoidReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [consulted, setConsulted] = useState<{ year: number; month: number; currency: string } | null>(
    null,
  )

  const ratesQuery = useQuery({
    queryKey: ["commission-rates", ownOnly ? fallbackProfessional : null],
    queryFn: () => fetchCommissionRates(ownOnly ? fallbackProfessional : undefined),
    retry: false,
  })
  const monthlyQuery = useQuery({
    queryKey: ["commissions-monthly", professional, consulted],
    queryFn: () =>
      ownOnly && !professionalUserId
        ? fetchMyCommissions({
            year: consulted?.year ?? Number(year),
            month: consulted?.month ?? Number(month),
            currency: consulted?.currency ?? currency,
          })
        : fetchMonthlyCommissions({
            professionalUserId: professional,
            year: consulted?.year ?? Number(year),
            month: consulted?.month ?? Number(month),
            currency: consulted?.currency ?? currency,
          }),
    enabled: consulted !== null && professional !== "",
    retry: false,
  })
  const settlementsQuery = useQuery({
    queryKey: ["commission-settlements", ownOnly ? fallbackProfessional : null],
    queryFn: () =>
      fetchCommissionSettlements(
        ownOnly || !adminMode ? { professionalUserId: fallbackProfessional } : {},
      ),
    retry: false,
  })
  const settlementQuery = useQuery({
    queryKey: ["commission-settlement", settlementId],
    queryFn: () => fetchCommissionSettlementDetail(settlementId as string),
    enabled: settlementId !== null,
    retry: false,
  })
  const branchesQuery = useQuery({
    queryKey: ["branches"],
    queryFn: () => apiFetch<{ data: Array<{ id: string; name: string }> }>("/api/branches"),
    enabled: canWrite,
    retry: false,
  })

  const monthly = monthlyQuery.data?.data ?? null
  const rates = ratesQuery.data?.data ?? []
  const settlements = settlementsQuery.data?.data ?? []
  const currentRate = rates.find((r) => r.professionalUserId === professional)?.rateBps

  const consult = (): void => {
    if (!professional) {
      setError("Elige el profesional.")
      return
    }
    if (!/^\d{4}$/.test(year) || !/^(0?[1-9]|1[0-2])$/.test(month) || !/^[A-Za-z]{3}$/.test(currency)) {
      setError("Elige mes, año y una moneda ISO de tres letras.")
      return
    }
    setError(null)
    setConsulted({ year: Number(year), month: Number(month), currency: currency.toUpperCase() })
  }

  const rateMutation = useMutation({
    mutationFn: () => {
      const rateBps = rateBpsFromPercent(rate)
      if (rateBps === null) throw new Error("Tasa inválida: usa un porcentaje entre 0 y 100.")
      return setCommissionRateApi({ professionalUserId: professional, rateBps })
    },
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ["commission-rates"] })
    },
    onError: (err) => setError(financeErrorMessage(err)),
  })
  const settleMutation = useMutation({
    mutationFn: () => {
      if (!consulted) throw new Error("Pulsa Consultar para ver el mes antes de liquidar.")
      return settleMonthCommissionsApi({
        professionalUserId: professional,
        year: consulted.year,
        month: consulted.month,
        currency: consulted.currency,
        notes: notes.trim() ? notes.trim() : undefined,
      })
    },
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ["commission-settlements"] })
      void queryClient.invalidateQueries({ queryKey: ["commissions-monthly"] })
    },
    onError: (err) => setError(financeErrorMessage(err)),
  })
  const payMutation = useMutation({
    mutationFn: () => payCommissionSettlementApi(settlementId as string, branchId),
    onSuccess: () => {
      setConfirmPay(false)
      setBranchId("")
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ["commission-settlements"] })
      void queryClient.invalidateQueries({ queryKey: ["commission-settlement", settlementId] })
      void queryClient.invalidateQueries({ queryKey: ["commissions-monthly"] })
    },
    onError: (err) => setError(financeErrorMessage(err)),
  })
  const voidMutation = useMutation({
    mutationFn: () => voidCommissionSettlementApi(settlementId as string, voidReason),
    onSuccess: () => {
      setConfirmVoid(false)
      setVoidReason("")
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ["commission-settlements"] })
      void queryClient.invalidateQueries({ queryKey: ["commission-settlement", settlementId] })
      void queryClient.invalidateQueries({ queryKey: ["commissions-monthly"] })
    },
    onError: (err) => setError(financeErrorMessage(err)),
  })

  if (profile.isPending) {
    return <p className="text-sm text-muted-foreground">Cargando la configuración de la clínica…</p>
  }
  if (profile.isError || !profile.data) {
    return (
      <EmptyState
        title="Sin configuración regional"
        description="No se pudo cargar la moneda y el formato de la clínica. Vuelve a intentarlo."
      />
    )
  }
  if (
    (ratesQuery.isError && ratesQuery.error instanceof ApiError && ratesQuery.error.status === 403) ||
    (settlementsQuery.isError &&
      settlementsQuery.error instanceof ApiError &&
      settlementsQuery.error.status === 403)
  ) {
    return (
      <EmptyState
        title="Sin acceso a comisiones"
        description="Tu rol no tiene permiso para ver comisiones. Pide a un administrador el acceso."
      />
    )
  }

  const locale = monthly?.locale ?? profile.data.locale
  const money = (cents: number, curr: string): string => formatMoney(cents, curr, locale)

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <section className="flex min-w-0 flex-col gap-2">
        <h3 className="text-base font-semibold">
          {ownOnly ? "Mis comisiones" : "Comisiones por profesional"}
        </h3>
        <p className="text-sm text-muted-foreground">
          {ownOnly
            ? "Un porcentaje sobre lo cobrado de lo que atendiste. Lo atendido que aún no se cobra entra cuando el paciente pague."
            : "Un porcentaje único por profesional sobre lo cobrado de lo que atendió. Lo que caja agrega sin atención no cuenta para nadie."}
        </p>
        <div className="flex flex-wrap items-end gap-2">
          {adminMode ? (
            <Field>
              <FieldLabel htmlFor="comm-prof">Profesional</FieldLabel>
              <ChoiceSelect
                id="comm-prof"
                className="h-9 rounded-md border bg-background px-3 text-sm"
                value={selectedProfessional}
                onChange={(event) => setSelectedProfessional(event.target.value)}
              >
                <option value="">Seleccionar</option>
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.user.name} ({m.role})
                  </option>
                ))}
              </ChoiceSelect>
            </Field>
          ) : null}
          <Field>
            <FieldLabel htmlFor="comm-year">Año</FieldLabel>
            <Input
              id="comm-year"
              inputMode="numeric"
              className="w-24"
              value={year}
              onChange={(event) => setYear(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="comm-month">Mes</FieldLabel>
            <Input
              id="comm-month"
              inputMode="numeric"
              className="w-20"
              value={month}
              onChange={(event) => setMonth(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="comm-currency">Moneda</FieldLabel>
            <Input
              id="comm-currency"
              className="w-24 uppercase"
              maxLength={3}
              value={currency}
              placeholder={profile.data.currency}
              onChange={(event) => {
                setCurrencyTouched(true)
                setCurrency(event.target.value)
              }}
            />
          </Field>
          <Button onClick={consult}>Consultar</Button>
        </div>
        {adminMode ? (
          <div className="flex flex-wrap items-end gap-2">
            <Field>
              <FieldLabel htmlFor="comm-rate">
                Tasa % {currentRate !== undefined ? `(actual ${currentRate / 100} %)` : "(sin tasa)"}
              </FieldLabel>
              <Input
                id="comm-rate"
                inputMode="decimal"
                className="w-24"
                value={rate}
                onChange={(event) => setRate(event.target.value)}
              />
            </Field>
            <Button
              variant="outline"
              disabled={rateMutation.isPending || !professional}
              onClick={() => rateMutation.mutate()}
            >
              Guardar tasa
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Tasa aplicada: {currentRate !== undefined ? `${currentRate / 100} %` : "sin tasa configurada"}.
          </p>
        )}
      </section>

      {monthlyQuery.isPending && consulted ? (
        <p className="text-sm text-muted-foreground">Cargando el mes…</p>
      ) : null}
      {monthly ? (
        <section className="flex min-w-0 flex-col gap-2">
          <h3 className="text-base font-semibold">
            {memberName(monthly.professionalUserId)} ·{" "}
            {monthLabel(monthly.year, monthly.month, locale)}
          </h3>
          <p className="text-sm font-medium">
            Se cobró {money(monthly.baseCents, monthly.currency)} de lo que atendió ·{" "}
            {monthly.rateBps / 100} % → {money(monthly.commissionCents, monthly.currency)}
            {monthly.settlement ? (
              <>
                {" · "}
                <Badge>{monthly.settlement.status}</Badge>
                {monthly.paidExpenseId ? " · pagada" : " · por pagar"}
              </>
            ) : (
              " · sin liquidar"
            )}
          </p>
          {monthly.lines.length === 0 ? (
            <EmptyState
              title="Sin cobros en el mes"
              description="Cuando se cobre algo de lo que atendió, aparece aquí el detalle."
            />
          ) : (
            <ul className="flex min-w-0 flex-col divide-y rounded-md border bg-card">
              {monthly.lines.map((line) => (
                <li
                  key={line.applicationId}
                  className="flex min-w-0 flex-wrap items-baseline gap-x-2 px-4 py-2 text-sm"
                >
                  <span className="min-w-0 flex-1">{line.description}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {money(line.baseCents, monthly.currency)}
                  </span>
                  <span className="tabular-nums font-medium">
                    {money(line.commissionCents, monthly.currency)}
                  </span>
                  {line.refundChargeCents > 0 ? (
                    <Badge>neto de devolución {money(line.refundChargeCents, monthly.currency)}</Badge>
                  ) : null}
                  {line.settled ? <Badge>liquidada</Badge> : null}
                </li>
              ))}
            </ul>
          )}
          {canWrite && !ownOnly ? (
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex flex-wrap items-end gap-2">
                <Field className="min-w-0 flex-1">
                  <FieldLabel htmlFor="comm-notes">Nota de la liquidación (opcional)</FieldLabel>
                  <Input
                    id="comm-notes"
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                  />
                </Field>
                <Button
                  disabled={
                    settleMutation.isPending ||
                    !consulted ||
                    consulted.year !== Number(year) ||
                    consulted.month !== Number(month) ||
                    consulted.currency !== currency.toUpperCase() ||
                    monthly.settlement !== null ||
                    monthly.pendingCents <= 0
                  }
                  onClick={() => settleMutation.mutate()}
                >
                  Liquidar el mes
                </Button>
              </div>
              {monthly.settlement ? (
                <p className="text-sm text-muted-foreground">
                  El mes ya tiene una liquidación vigente.
                </p>
              ) : monthly.pendingCents <= 0 ? (
                <p className="text-sm text-muted-foreground">
                  Sin cobros pendientes de liquidar en este mes.
                </p>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="flex min-w-0 flex-col gap-2">
        <h3 className="text-base font-semibold">Liquidaciones</h3>
        {settlements.length === 0 ? (
          <EmptyState
            title="Sin liquidaciones"
            description="Al liquidar, las líneas trazables quedan congeladas para consulta posterior."
          />
        ) : (
          <ul className="flex min-w-0 flex-col divide-y rounded-md border bg-card">
            {settlements.map((settlement) => (
              <li key={settlement.id}>
                <button
                  type="button"
                  className="flex w-full flex-wrap items-center gap-2 px-4 py-2 text-left hover:bg-muted"
                  onClick={() => setSettlementId(settlement.id)}
                >
                  <Badge>{settlement.status}</Badge>
                  {!ownOnly ? (
                    <span className="font-medium">
                      {settlement.professionalName ?? memberName(settlement.professionalUserId)}
                    </span>
                  ) : null}
                  <span className="text-sm text-muted-foreground">
                    {settlement.periodYear !== null && settlement.periodMonth !== null
                      ? `${settlement.periodYear}-${String(settlement.periodMonth).padStart(2, "0")}`
                      : settlement.periodFrom && settlement.periodTo
                        ? `${settlement.periodFrom} al ${settlement.periodTo}`
                        : "histórico"}{" "}
                    · {settlement.rateBps !== null ? `${settlement.rateBps / 100} %` : "multirregla"}
                  </span>
                  <span className="text-sm font-medium tabular-nums">
                    {money(settlement.commissionCents, settlement.currency)}
                  </span>
                  {settlement.expenseId ? <Badge>pagada</Badge> : <Badge>por pagar</Badge>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {settlementQuery.data ? (
          <div className="rounded-md border bg-card px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">
                Detalle · base{" "}
                {money(
                  settlementQuery.data.data.settlement.baseCents,
                  settlementQuery.data.data.settlement.currency,
                )}{" "}
                · comisión{" "}
                {money(
                  settlementQuery.data.data.settlement.commissionCents,
                  settlementQuery.data.data.settlement.currency,
                )}
              </p>
              {canWrite && settlementQuery.data.data.settlement.status === "liquidada" ? (
                <>
                  {!settlementQuery.data.data.settlement.expenseId ? (
                    <Button variant="outline" onClick={() => setConfirmPay(true)}>
                      Registrar el pago
                    </Button>
                  ) : null}
                  <Button variant="ghost" onClick={() => setConfirmVoid(true)}>
                    Anular liquidación
                  </Button>
                </>
              ) : null}
            </div>
            <ul className="mt-2 flex min-w-0 flex-col divide-y">
              {settlementQuery.data.data.lines.map((line) => (
                <li key={line.applicationId} className="py-1 text-sm">
                  {line.description} · base{" "}
                  {money(line.baseCents, settlementQuery.data.data.settlement.currency)} →{" "}
                  {money(line.commissionCents, settlementQuery.data.data.settlement.currency)}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">
              El pago queda como gasto de Personal. Anular la liquidación anula también ese gasto.
            </p>
          </div>
        ) : null}
      </section>

      <FormDrawer
        dock={false}
        open={confirmPay}
        title="Registrar el pago"
        description="Queda como gasto de Personal, una sola vez por liquidación."
        error={error}
        isSubmitting={payMutation.isPending}
        submitLabel="Registrar pago"
        onClose={() => {
          if (!payMutation.isPending) {
            setConfirmPay(false)
            setError(null)
          }
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!branchId) {
            setError("Elige la sede del gasto.")
            return
          }
          payMutation.mutate()
        }}
      >
        <Field>
          <FieldLabel htmlFor="comm-pay-branch">Sede del gasto</FieldLabel>
          <ChoiceSelect
            id="comm-pay-branch"
            className="h-9 rounded-md border bg-background px-3 text-sm"
            value={branchId}
            onChange={(event) => setBranchId(event.target.value)}
          >
            <option value="">Seleccionar</option>
            {(branchesQuery.data?.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </ChoiceSelect>
        </Field>
      </FormDrawer>

      <FormDrawer
        dock={false}
        open={confirmVoid}
        title="Anular liquidación"
        description="Las líneas congeladas se conservan como histórico de la anulación."
        error={error}
        isSubmitting={voidMutation.isPending}
        submitLabel="Anular"
        onClose={() => {
          if (!voidMutation.isPending) {
            setConfirmVoid(false)
            setError(null)
          }
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!voidReason.trim()) {
            setError("Indica el motivo de la anulación.")
            return
          }
          voidMutation.mutate()
        }}
      >
        <Field>
          <FieldLabel htmlFor="comm-void-reason">Motivo</FieldLabel>
          <Textarea
            id="comm-void-reason"
            value={voidReason}
            onChange={(event) => setVoidReason(event.target.value)}
          />
        </Field>
      </FormDrawer>
    </div>
  )
}
