-- Inventario por sede, unidades, materiales y venta: reglas y datos (ADR 0067).
-- Va entre la 0037 (lo que se agrega) y la 0039 (lo que se quita): pasa los
-- datos de las columnas viejas antes de quitarlas.

-- 1. Las tablas nuevas nacen cerradas al rol de la app (ADR 0063): se concede
-- solo lo que usa, con su RLS. Nada de inventario se borra: el mínimo de una
-- sede y los materiales de un servicio se ponen en cero o se reemplazan, salvo
-- la fila de un material que se quita del servicio, que sí se borra.
GRANT SELECT,INSERT,UPDATE ON TABLE public.product_minimum TO dentalagent_app;--> statement-breakpoint
ALTER TABLE public.product_minimum ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.product_minimum FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.product_minimum USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.service_material TO dentalagent_app;--> statement-breakpoint
ALTER TABLE public.service_material ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.service_material FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.service_material USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.stock_shortage TO dentalagent_app;--> statement-breakpoint
ALTER TABLE public.stock_shortage ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ONLY public.stock_shortage FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_isolation ON public.stock_shortage USING ((organization_id = NULLIF(current_setting('app.org_id'::text, true), ''::text)));--> statement-breakpoint

-- 2. El producto vendido en «Cobrar» es de la misma clínica (`patient` no
-- importa `product` en el esquema: el vínculo compuesto vive aquí).
ALTER TABLE ONLY public.patient_charge ADD CONSTRAINT patient_charge_product_fk FOREIGN KEY (organization_id, product_id) REFERENCES public.product(organization_id, id);--> statement-breakpoint

-- 3. Cada sede tiene su almacén principal. Las que ya tienen almacenes marcan
-- el más antiguo activo; las demás reciben «Almacén principal».
UPDATE public.warehouse w SET is_default = true
  WHERE w.id = (
    SELECT x.id FROM public.warehouse x
    WHERE x.organization_id = w.organization_id AND x.branch_id = w.branch_id AND x.is_active
    ORDER BY x.created_at, x.id LIMIT 1
  );--> statement-breakpoint
INSERT INTO public.warehouse (organization_id, branch_id, name, is_default)
  SELECT b.organization_id, b.id, 'Almacén principal', true FROM public.branch b
  WHERE NOT EXISTS (
    SELECT 1 FROM public.warehouse w WHERE w.organization_id = b.organization_id AND w.branch_id = b.id AND w.is_default
  );--> statement-breakpoint

-- Una sede nueva nace con su almacén principal, venga de donde venga (la API,
-- el alta de la clínica o una semilla).
CREATE FUNCTION public.branch_default_warehouse() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO "warehouse" (organization_id, branch_id, name, is_default)
    VALUES (NEW.organization_id, NEW.id, 'Almacén principal', true);
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER branch_default_warehouse AFTER INSERT ON public.branch FOR EACH ROW EXECUTE FUNCTION public.branch_default_warehouse();--> statement-breakpoint

-- 4. Se usa, se vende o las dos: el «producto» de antes era lo que se vende.
UPDATE public.product SET used_in_care = (kind = 'insumo'), for_sale = (kind = 'producto');--> statement-breakpoint

-- 5. Unidades. «caja x 100» se lee como «se compra por caja de 100 unidades»
-- (con el nombre de la unidad si viene, en singular: «caja x 50 cartuchos» →
-- cartucho). Lo que había se contaba en cajas: lotes, movimientos y el mínimo
-- pasan a unidades de uso con el mismo factor; las líneas de compra siguen en
-- cajas y guardan su factor. Lo que no se entiende y lleva números queda «Por
-- revisar», sin tocar lo que hay.
CREATE TEMPORARY TABLE product_unit_parse AS
  SELECT p.id, p.organization_id,
    lower(m[1]) AS purchase_unit,
    m[2]::integer AS factor,
    nullif(trim(m[3]), '') AS rest
  FROM public.product p
  CROSS JOIN LATERAL regexp_match(p.unit, '^\s*([[:alpha:]]+)\s*(?:x|de)\s*([0-9]{1,6})\s*(.*)$', 'i') AS m
  WHERE m IS NOT NULL AND m[2]::integer BETWEEN 2 AND 100000;--> statement-breakpoint
UPDATE public.product p SET
    purchase_unit = u.purchase_unit,
    purchase_factor = u.factor,
    unit = CASE
      WHEN u.rest IS NULL THEN 'unidad'
      WHEN lower(u.rest) ~ '[dlrnj]es$' THEN regexp_replace(lower(u.rest), 'es$', '')
      WHEN lower(u.rest) ~ 'ces$' THEN regexp_replace(lower(u.rest), 'ces$', 'z')
      WHEN lower(u.rest) ~ 's$' THEN regexp_replace(lower(u.rest), 's$', '')
      ELSE lower(u.rest)
    END,
    min_stock = p.min_stock * u.factor
  FROM product_unit_parse u WHERE u.id = p.id;--> statement-breakpoint
UPDATE public.product_lot l SET quantity_on_hand = l.quantity_on_hand * u.factor
  FROM product_unit_parse u WHERE u.organization_id = l.organization_id AND u.id = l.product_id;--> statement-breakpoint
UPDATE public.stock_movement m SET quantity_delta = m.quantity_delta * u.factor
  FROM product_unit_parse u WHERE u.organization_id = m.organization_id AND u.id = m.product_id;--> statement-breakpoint
UPDATE public.purchase_order_line l SET unit_factor = u.factor, purchase_unit = u.purchase_unit
  FROM product_unit_parse u WHERE u.organization_id = l.organization_id AND u.id = l.product_id;--> statement-breakpoint
UPDATE public.product p SET unit_review = true
  WHERE p.unit ~ '[0-9]' AND NOT EXISTS (SELECT 1 FROM product_unit_parse u WHERE u.id = p.id);--> statement-breakpoint
DROP TABLE product_unit_parse;--> statement-breakpoint

-- 6. El mínimo pasa a cada sede activa de la clínica.
INSERT INTO public.product_minimum (organization_id, product_id, branch_id, min_quantity)
  SELECT p.organization_id, p.id, b.id, p.min_stock FROM public.product p
  JOIN public.branch b ON b.organization_id = p.organization_id AND b.is_active
  WHERE p.min_stock > 0
  ON CONFLICT DO NOTHING;--> statement-breakpoint

-- 7. Una compra en borrador se edita: sus productos se reemplazan y el que se
-- quita se borra. La app no borra nada más de una compra: una línea de una
-- compra pedida, recibida, cerrada o cancelada es historia (la base lo exige).
-- El rol owner conserva el mantenimiento de datos semilla, como en finance_no_delete.
GRANT DELETE ON TABLE public.purchase_order_line TO dentalagent_app;--> statement-breakpoint
CREATE FUNCTION public.purchase_order_line_draft_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RETURN OLD;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "purchase_order" o
    WHERE o.organization_id = OLD.organization_id AND o.id = OLD.order_id AND o.status = 'borrador'
  ) THEN
    RAISE EXCEPTION 'Solo se quitan productos de una compra en borrador' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER purchase_order_line_draft_delete BEFORE DELETE ON public.purchase_order_line FOR EACH ROW EXECUTE FUNCTION public.purchase_order_line_draft_delete();--> statement-breakpoint

-- 8. «Registrar uso» fuera de una atención no siempre es con un paciente (lo
-- que se regaló o se usó en la recepción): el paciente pasa a ser opcional en
-- el uso. Lo que se une a una atención sigue exigiendo su paciente
-- (`stock_movement_encounter_patient_check` y el vínculo compuesto).
ALTER TABLE public.stock_movement DROP CONSTRAINT stock_movement_consume_patient_check;
