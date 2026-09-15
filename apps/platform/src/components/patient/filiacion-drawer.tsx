import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Field,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui";
import { FormDrawer, SubmitButton } from "@odentia/ui-patterns";
import { useEffect, useState } from "react";
import { ApiError, apiFetch } from "../../lib/api";
import { timeAgo, useCanWrite } from "../../lib/crm";
import type { PatientFull } from "../../lib/patients";

interface Branch {
  id: string;
  name: string;
}

const DOC_TYPE_ITEMS = { "": "—", DNI: "DNI", CE: "CE", PASAPORTE: "Pasaporte", OTRO: "Otro" } as const;
const SEX_ITEMS = { "": "—", M: "Masculino", F: "Femenino" } as const;
const INSURANCE_ITEMS = {
  "": "—",
  PARTICULAR: "Particular",
  SIS: "SIS",
  ESSALUD: "EsSalud",
  EPS: "EPS",
  OTRO: "Otro",
} as const;
const BRANCH_NONE = "Sin asignar";

function strField(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function errorText(error: unknown): string | null {
  if (error instanceof ApiError) {
    const shape = error.shape as { message?: unknown; code?: unknown };
    if (typeof shape.message === "string" && shape.message !== "") return shape.message;
    if (typeof shape.code === "string" && shape.code !== "") return `Error: ${shape.code}`;
    return `Error ${error.status}`;
  }
  if (error instanceof Error && error.message !== "") return error.message;
  return null;
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">{children}</CardContent>
    </Card>
  );
}

/** Edición de filiación del paciente (drawer controlado). */
export function FiliacionDrawer({
  patientId,
  detail,
  open,
  onOpenChange,
}: {
  patientId: string;
  detail: PatientFull;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();
  const p = detail.patient;

  const [docType, setDocType] = useState<string>(strField(p.docType));
  const [sex, setSex] = useState<string>(strField(p.sex));
  const [insuranceType, setInsuranceType] = useState<string>(strField(p.insuranceType));
  const [branchId, setBranchId] = useState<string>(strField(p.registeredBranchId));
  const [isActive, setIsActive] = useState<boolean>(p.isActive);

  useEffect(() => {
    if (open) {
      setDocType(strField(p.docType));
      setSex(strField(p.sex));
      setInsuranceType(strField(p.insuranceType));
      setBranchId(strField(p.registeredBranchId));
      setIsActive(p.isActive);
    }
    // Se resincroniza al abrir con el detalle vigente.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const branchesQuery = useQuery({
    queryKey: ["branches"],
    queryFn: () => apiFetch<{ data: Branch[] }>("/api/branches"),
    enabled: open,
  });

  const invalidatePatient = () => {
    void queryClient.invalidateQueries({ queryKey: ["patient", patientId] });
    void queryClient.invalidateQueries({ queryKey: ["patients"] });
  };

  const patchMutation = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      apiFetch(`/api/patients/${patientId}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => {
      invalidatePatient();
      onOpenChange(false);
    },
  });

  const consentGiven = p.dataConsentAt != null;
  const branchItems: Record<string, string> = { "": BRANCH_NONE };
  for (const b of branchesQuery.data?.data ?? []) branchItems[b.id] = b.name;

  return (
    <FormDrawer
      open={open}
      onClose={() => !patchMutation.isPending && onOpenChange(false)}
      title="Editar filiación"
      onSubmit={(e) => {
        e.preventDefault();
        if (patchMutation.isPending || !canWrite) return;
        const form = new FormData(e.currentTarget as HTMLFormElement);
        const str = (k: string) => {
          const v = String(form.get(k) ?? "").trim();
          return v === "" ? null : v;
        };
        void patchMutation.mutate({
          docType: docType === "" ? null : docType,
          docNumber: str("docNumber"),
          birthDate: str("birthDate"),
          sex: sex === "" ? null : sex,
          phone: str("phone"),
          email: str("email"),
          maritalStatus: str("maritalStatus"),
          educationLevel: str("educationLevel"),
          occupation: str("occupation"),
          address: str("address"),
          origin: str("origin"),
          emergencyContactName: str("emergencyContactName"),
          emergencyContactPhone: str("emergencyContactPhone"),
          insuranceType: insuranceType === "" ? null : insuranceType,
          insuranceDetail: str("insuranceDetail"),
          referralSource: str("referralSource"),
          registeredBranchId: branchId === "" ? null : branchId,
          isActive,
        });
      }}
      isSubmitting={patchMutation.isPending}
      submitDisabled={!canWrite}
      submitLabel="Guardar filiación"
      error={patchMutation.isError ? (errorText(patchMutation.error) ?? "No se pudo guardar la filiación.") : null}
      className="sm:max-w-2xl"
    >
      <div className="flex flex-col gap-4">
        <SectionCard title="Identidad">
          <Field>
            <FieldLabel htmlFor="filiacion-docType">Tipo de documento</FieldLabel>
            <Select value={docType} items={DOC_TYPE_ITEMS} onValueChange={(v) => setDocType(v ?? "")}>
              <SelectTrigger id="filiacion-docType" aria-label="Tipo de documento">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(DOC_TYPE_ITEMS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="filiacion-docNumber">Número de documento</FieldLabel>
            <Input
              id="filiacion-docNumber"
              name="docNumber"
              defaultValue={strField(p.docNumber)}
              maxLength={20}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="filiacion-birthDate">Fecha de nacimiento</FieldLabel>
            <Input id="filiacion-birthDate" type="date" name="birthDate" defaultValue={strField(p.birthDate)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="filiacion-sex">Sexo</FieldLabel>
            <Select value={sex} items={SEX_ITEMS} onValueChange={(v) => setSex(v ?? "")}>
              <SelectTrigger id="filiacion-sex" aria-label="Sexo">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(SEX_ITEMS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </SectionCard>

        <SectionCard title="Contacto">
          <Field>
            <FieldLabel htmlFor="filiacion-phone">Teléfono</FieldLabel>
            <Input
              id="filiacion-phone"
              name="phone"
              type="tel"
              defaultValue={strField(p.phone)}
              maxLength={50}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="filiacion-email">Correo electrónico</FieldLabel>
            <Input
              id="filiacion-email"
              name="email"
              type="email"
              defaultValue={strField(p.email)}
              maxLength={200}
            />
          </Field>
        </SectionCard>

        <SectionCard title="Datos personales">
          <Field>
            <FieldLabel htmlFor="filiacion-maritalStatus">Estado civil</FieldLabel>
            <Input id="filiacion-maritalStatus" name="maritalStatus" defaultValue={strField(p.maritalStatus)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="filiacion-educationLevel">Grado de instrucción</FieldLabel>
            <Input
              id="filiacion-educationLevel"
              name="educationLevel"
              defaultValue={strField(p.educationLevel)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="filiacion-occupation">Ocupación</FieldLabel>
            <Input id="filiacion-occupation" name="occupation" defaultValue={strField(p.occupation)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="filiacion-origin">Procedencia</FieldLabel>
            <Input id="filiacion-origin" name="origin" defaultValue={strField(p.origin)} />
          </Field>
        </SectionCard>

        <SectionCard title="Dirección">
          <div className="sm:col-span-2">
            <Field>
              <FieldLabel htmlFor="filiacion-address">Domicilio</FieldLabel>
              <Input id="filiacion-address" name="address" defaultValue={strField(p.address)} />
            </Field>
          </div>
        </SectionCard>

        <SectionCard title="Seguro">
          <Field>
            <FieldLabel htmlFor="filiacion-insuranceType">Seguro</FieldLabel>
            <Select
              value={insuranceType}
              items={INSURANCE_ITEMS}
              onValueChange={(v) => setInsuranceType(v ?? "")}
            >
              <SelectTrigger id="filiacion-insuranceType" aria-label="Seguro">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(INSURANCE_ITEMS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="filiacion-insuranceDetail">Detalle del seguro</FieldLabel>
            <Input
              id="filiacion-insuranceDetail"
              name="insuranceDetail"
              defaultValue={strField(p.insuranceDetail)}
            />
          </Field>
        </SectionCard>

        <SectionCard title="Emergencia y canal">
          <Field>
            <FieldLabel htmlFor="filiacion-emergencyContactName">Contacto de emergencia</FieldLabel>
            <Input
              id="filiacion-emergencyContactName"
              name="emergencyContactName"
              defaultValue={strField(p.emergencyContactName)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="filiacion-emergencyContactPhone">Teléfono de emergencia</FieldLabel>
            <Input
              id="filiacion-emergencyContactPhone"
              name="emergencyContactPhone"
              type="tel"
              defaultValue={strField(p.emergencyContactPhone)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="filiacion-referralSource">Referido por</FieldLabel>
            <Input
              id="filiacion-referralSource"
              name="referralSource"
              defaultValue={strField(p.referralSource)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="filiacion-registeredBranchId">Sucursal de registro</FieldLabel>
            <Select
              value={branchId}
              items={branchItems}
              disabled={branchesQuery.isLoading}
              onValueChange={(v) => setBranchId(v ?? "")}
            >
              <SelectTrigger id="filiacion-registeredBranchId" aria-label="Sucursal de registro">
                <SelectValue placeholder={branchesQuery.isLoading ? "Cargando…" : BRANCH_NONE} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">{BRANCH_NONE}</SelectItem>
                {(branchesQuery.data?.data ?? []).map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </SectionCard>

        <SectionCard title="Estado">
          <div className="sm:col-span-2">
            <Field className="flex-row items-center gap-2">
              <Checkbox
                id="filiacion-isActive"
                checked={isActive}
                onCheckedChange={(c) => setIsActive(c === true)}
              />
              <FieldLabel htmlFor="filiacion-isActive" className="font-normal">
                Paciente activo
              </FieldLabel>
            </Field>
          </div>
        </SectionCard>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Consentimiento de datos</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {consentGiven ? (
              <p className="text-sm text-muted-foreground">
                Consentimiento registrado el {timeAgo(p.dataConsentAt ?? null)}. No puede retirarse desde este
                formulario.
              </p>
            ) : canWrite ? (
              <>
                <p className="text-sm text-muted-foreground">
                  Datos de salud sensibles (Ley 29733): se requiere consentimiento expreso del paciente o tutor.
                </p>
                <div>
                  <SubmitButton
                    type="button"
                    pending={patchMutation.isPending}
                    onClick={() => void patchMutation.mutate({ dataConsent: true })}
                  >
                    Registrar consentimiento
                  </SubmitButton>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Sin consentimiento de datos registrado.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </FormDrawer>
  );
}
