ALTER TABLE "imaging_measurement" ADD COLUMN "series_instance_uid" text;--> statement-breakpoint
-- Las medidas de antes se marcaron en la serie mayor, la única que se veía (ADR 0151): la de más
-- archivos y, si empatan, la del primer archivo, como la elige el visor. Lo retirado no se toca.
UPDATE public.imaging_measurement m
SET series_instance_uid = (
  SELECT f.series_instance_uid
  FROM public.imaging_study_file f
  WHERE f.organization_id = m.organization_id AND f.document_id = m.document_id
  GROUP BY f.series_instance_uid
  ORDER BY count(*) DESC, min(f.file_index) ASC
  LIMIT 1
)
WHERE m.series_instance_uid IS NULL AND m.retired_at IS NULL;
