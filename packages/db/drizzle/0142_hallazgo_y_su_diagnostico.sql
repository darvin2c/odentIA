CREATE UNIQUE INDEX "encounter_diagnosis_org_patient_id_uidx" ON "encounter_diagnosis" USING btree ("organization_id","patient_id","id");--> statement-breakpoint
CREATE TABLE "dental"."diagnosis_finding" (
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"diagnosis_id" uuid NOT NULL,
	"odontogram_entry_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "diagnosis_finding_odontogram_entry_id_diagnosis_id_pk" PRIMARY KEY("odontogram_entry_id","diagnosis_id")
);
--> statement-breakpoint
ALTER TABLE "dental"."diagnosis_finding" ADD CONSTRAINT "diagnosis_finding_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dental"."diagnosis_finding" ADD CONSTRAINT "diagnosis_finding_diagnosis_fk" FOREIGN KEY ("organization_id","patient_id","diagnosis_id") REFERENCES "public"."encounter_diagnosis"("organization_id","patient_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dental"."diagnosis_finding" ADD CONSTRAINT "diagnosis_finding_entry_fk" FOREIGN KEY ("organization_id","patient_id","odontogram_entry_id") REFERENCES "dental"."odontogram_entry"("organization_id","patient_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "diagnosis_finding_diagnosis_idx" ON "dental"."diagnosis_finding" USING btree ("organization_id","diagnosis_id");--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- dental.diagnosis_finding
-- ═════════════════════════════════════════════════════════════════════════
-- El diagnóstico que nació con un hallazgo se anota al crearlos y no se cambia:
-- la aplicación solo lo agrega y lo lee (lo anulado se ve en cada fila).
ALTER TABLE dental.diagnosis_finding ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY dental.diagnosis_finding FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON dental.diagnosis_finding USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text))) WITH CHECK ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE dental.diagnosis_finding TO dentalagent_app;--> statement-breakpoint

-- Las atenciones en borrador al desplegar: el hallazgo y su diagnóstico nacen en la
-- misma transacción del panel de la pieza (misma atención, misma pieza y el mismo
-- `created_at`, que es el `now()` de la transacción), o el diagnóstico lleva el mismo
-- código que el hallazgo (la segunda caries que se sumó al diagnóstico de la primera).
-- Lo firmado no se anula desde la atención, así que no se rellena.
INSERT INTO dental.diagnosis_finding (organization_id, patient_id, diagnosis_id, odontogram_entry_id, created_at)
SELECT DISTINCT e.organization_id, e.patient_id, d.id, e.id, e.created_at
FROM dental.odontogram_entry e
JOIN public.encounter en ON en.organization_id = e.organization_id AND en.id = e.encounter_id AND en.status = 'borrador'
JOIN public.encounter_diagnosis d ON d.organization_id = e.organization_id AND d.patient_id = e.patient_id
  AND d.encounter_id = e.encounter_id AND d.voided_at IS NULL
  AND d.site_system = 'ISO-3950' AND d.site_code = e.tooth_number::text
WHERE e.voided_at IS NULL
  AND (d.created_at = e.created_at
    OR (d.diagnosis_system = e.diagnosis_system AND d.diagnosis_code = e.diagnosis_code))
ON CONFLICT DO NOTHING;
