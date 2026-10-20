-- Inventario cuida su historia (cierre de Inventario, fase 1).

-- 1. Lo que el rol de la app hace con inventario. Estas tablas nacieron con
-- lectura y escritura completas (el init de la imagen, antes de la ADR 0063).
-- La aplicación no borra nada de inventario: un producto, un almacén o un
-- proveedor se desactivan, una orden se cancela y un lote se queda con su
-- historia. El ledger (`stock_movement`) ya era de solo inserción.
REVOKE ALL ON TABLE public.product FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.product TO dentalagent_app;--> statement-breakpoint
REVOKE ALL ON TABLE public.product_lot FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.product_lot TO dentalagent_app;--> statement-breakpoint
REVOKE ALL ON TABLE public.purchase_order FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.purchase_order TO dentalagent_app;--> statement-breakpoint
REVOKE ALL ON TABLE public.purchase_order_line FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.purchase_order_line TO dentalagent_app;--> statement-breakpoint
REVOKE ALL ON TABLE public.supplier FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.supplier TO dentalagent_app;--> statement-breakpoint
REVOKE ALL ON TABLE public.warehouse FROM dentalagent_app;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE public.warehouse TO dentalagent_app;--> statement-breakpoint

-- 2. La llegada de un traslado guardaba el destino en `warehouse_id` y el
-- origen en `dest_warehouse_id`, al revés de lo que dice el esquema y de su
-- fila de salida. Queda como la salida: origen en `warehouse_id`, destino en
-- `dest_warehouse_id`; el lote de cada fila dice dónde quedó el saldo.
UPDATE public.stock_movement SET warehouse_id = dest_warehouse_id, dest_warehouse_id = warehouse_id
  WHERE kind = 'traslado' AND quantity_delta > 0;--> statement-breakpoint

-- 3. Vínculos compuestos (organización, id): ninguna fila de inventario apunta
-- a la sede, el proveedor, el almacén, el producto, el lote o la orden de otra
-- clínica, aunque el servicio lo pase por alto. Los vínculos simples de
-- `0000_base` siguen; estos los acotan a la misma organización.
ALTER TABLE ONLY public.warehouse ADD CONSTRAINT warehouse_branch_id_org_fk FOREIGN KEY (organization_id, branch_id) REFERENCES public.branch(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.purchase_order ADD CONSTRAINT purchase_order_supplier_id_org_fk FOREIGN KEY (organization_id, supplier_id) REFERENCES public.supplier(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.purchase_order ADD CONSTRAINT purchase_order_warehouse_id_org_fk FOREIGN KEY (organization_id, warehouse_id) REFERENCES public.warehouse(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.purchase_order_line ADD CONSTRAINT purchase_order_line_order_id_org_fk FOREIGN KEY (organization_id, order_id) REFERENCES public.purchase_order(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.purchase_order_line ADD CONSTRAINT purchase_order_line_product_id_org_fk FOREIGN KEY (organization_id, product_id) REFERENCES public.product(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.product_lot ADD CONSTRAINT product_lot_product_id_org_fk FOREIGN KEY (organization_id, product_id) REFERENCES public.product(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.product_lot ADD CONSTRAINT product_lot_warehouse_id_org_fk FOREIGN KEY (organization_id, warehouse_id) REFERENCES public.warehouse(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.product_lot ADD CONSTRAINT product_lot_supplier_id_org_fk FOREIGN KEY (organization_id, supplier_id) REFERENCES public.supplier(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.product_lot ADD CONSTRAINT product_lot_purchase_order_id_org_fk FOREIGN KEY (organization_id, purchase_order_id) REFERENCES public.purchase_order(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.stock_movement ADD CONSTRAINT stock_movement_product_id_org_fk FOREIGN KEY (organization_id, product_id) REFERENCES public.product(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.stock_movement ADD CONSTRAINT stock_movement_lot_id_org_fk FOREIGN KEY (organization_id, lot_id) REFERENCES public.product_lot(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.stock_movement ADD CONSTRAINT stock_movement_warehouse_id_org_fk FOREIGN KEY (organization_id, warehouse_id) REFERENCES public.warehouse(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.stock_movement ADD CONSTRAINT stock_movement_dest_warehouse_id_org_fk FOREIGN KEY (organization_id, dest_warehouse_id) REFERENCES public.warehouse(organization_id, id);--> statement-breakpoint
ALTER TABLE ONLY public.stock_movement ADD CONSTRAINT stock_movement_purchase_order_id_org_fk FOREIGN KEY (organization_id, purchase_order_id) REFERENCES public.purchase_order(organization_id, id);
