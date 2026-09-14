import { useForm } from "@tanstack/react-form";
import { createFileRoute } from "@tanstack/react-router";
import { Button, Field, FieldDescription, FieldError, FieldGroup, FieldLabel, Input, toast } from "@odentia/ui";
import { PageHeader, PageShell, SubmitButton, fieldErrorMessages } from "@odentia/ui-patterns";
import { useState } from "react";
import { z } from "zod";
import { apiFetch } from "../lib/api";
import { authClient } from "../lib/auth-client";
import { requireVerifiedSession } from "../lib/guards";
import { BASE_DOMAIN, tenantUrl } from "../lib/host";

export const Route = createFileRoute("/onboarding")({
  beforeLoad: () => requireVerifiedSession(),
  component: OnboardingPage,
});

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const RESERVED_SLUGS: Record<string, true> = { api: true, app: true, www: true };

const onboardingSchema = z.object({
  orgName: z.string().min(2, "Nombre de la organización"),
  slug: z
    .string()
    .regex(slugPattern, "Slug inválido (minúsculas, números y guiones)")
    .refine((slug) => !RESERVED_SLUGS[slug], "Ese subdominio está reservado"),
  legalName: z.string().min(2, "Razón social"),
  fiscalDocNumber: z.string().max(20),
  branchName: z.string().min(2, "Nombre de la sucursal"),
  branchAddress: z.string(),
});

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function OnboardingPage() {
  const [step, setStep] = useState<"org" | "profile" | "branch">("org");
  const form = useForm({
    defaultValues: {
      orgName: "",
      slug: "",
      legalName: "",
      fiscalDocNumber: "",
      branchName: "",
      branchAddress: "",
    },
    validators: { onSubmit: onboardingSchema },
    onSubmit: async ({ value }) => {
      const { error: orgError } = await authClient.organization.create({
        name: value.orgName,
        slug: value.slug,
      });
      if (orgError) {
        setStep("org");
        toast.error(orgError.message ?? "No se pudo crear la organización (¿slug en uso?).");
        return;
      }
      try {
        await apiFetch("/api/org-profile", {
          method: "PUT",
          body: JSON.stringify({
            legalName: value.legalName,
            fiscalDocNumber: value.fiscalDocNumber || undefined,
            countryCode: "PE",
          }),
        });
        await apiFetch("/api/branches", {
          method: "POST",
          body: JSON.stringify({
            name: value.branchName,
            addressLine1: value.branchAddress || undefined,
          }),
        });
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : "Error al guardar los datos.");
        return;
      }
      window.location.assign(tenantUrl(value.slug, "/branches"));
    },
  });

  return (
    <PageShell maxWidth="md" className="py-10">
      <PageHeader
        title="Configura tu clínica"
        subtitle={
          step === "org"
            ? "Paso 1 de 3: organización"
            : step === "profile"
              ? "Paso 2 de 3: perfil legal"
              : "Paso 3 de 3: primera sucursal"
        }
      />
      <form
        className="mt-8"
        onSubmit={(event) => {
          event.preventDefault();
          if (step === "org") return setStep("profile");
          if (step === "profile") return setStep("branch");
          void form.handleSubmit();
        }}
      >
      <FieldGroup className="gap-4">
        <div className={step === "org" ? "flex flex-col gap-4" : "hidden"}>
          <form.Field name="orgName">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="orgName">Nombre de la organización</FieldLabel>
                <Input
                  id="orgName"
                  value={field.state.value}
                  onChange={(event) => {
                    field.handleChange(event.target.value);
                    const slugField = form.getFieldValue("slug");
                    if (!slugField) form.setFieldValue("slug", slugify(event.target.value));
                  }}
                />
                <FieldError>
                  {fieldErrorMessages(field.state.meta.errors)[0] ?? null}
                </FieldError>
              </Field>
            )}
          </form.Field>
          <form.Field name="slug">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="slug">Slug (subdominio)</FieldLabel>
                <Input
                  id="slug"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldDescription>
                  {field.state.value || "tu-clinica"}.{BASE_DOMAIN}
                </FieldDescription>
                <FieldError>
                  {fieldErrorMessages(field.state.meta.errors)[0] ?? null}
                </FieldError>
              </Field>
            )}
          </form.Field>
        </div>

        <div className={step === "profile" ? "flex flex-col gap-4" : "hidden"}>
          <form.Field name="legalName">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="legalName">Razón social</FieldLabel>
                <Input
                  id="legalName"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError>
                  {fieldErrorMessages(field.state.meta.errors)[0] ?? null}
                </FieldError>
              </Field>
            )}
          </form.Field>
          <form.Field name="fiscalDocNumber">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="fiscalDocNumber">RUC (opcional)</FieldLabel>
                <Input
                  id="fiscalDocNumber"
                  inputMode="numeric"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </Field>
            )}
          </form.Field>
        </div>

        <div className={step === "branch" ? "flex flex-col gap-4" : "hidden"}>
          <form.Field name="branchName">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="branchName">Nombre de la sucursal</FieldLabel>
                <Input
                  id="branchName"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError>
                  {fieldErrorMessages(field.state.meta.errors)[0] ?? null}
                </FieldError>
              </Field>
            )}
          </form.Field>
          <form.Field name="branchAddress">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="branchAddress">Dirección (opcional)</FieldLabel>
                <Input
                  id="branchAddress"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </Field>
            )}
          </form.Field>
        </div>


        <div className="flex justify-between">
          {step !== "org" ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => setStep(step === "branch" ? "profile" : "org")}
            >
              Atrás
            </Button>
          ) : (
            <span />
          )}
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
              <SubmitButton type="submit" pending={isSubmitting}>
                {step === "branch" ? "Crear organización" : "Continuar"}
              </SubmitButton>
            )}
          </form.Subscribe>
        </div>
      </FieldGroup>
      </form>
    </PageShell>
  );
}
