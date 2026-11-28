-- Los pedidos de prueba («Probar a Sofi», «Probar como clienta») llevan su propia numeración: una
-- prueba no gasta el número de una venta. Los números que ya usaron las pruebas no cambian.
ALTER TABLE "sale_order" DROP CONSTRAINT "sale_order_number_key";--> statement-breakpoint
CREATE UNIQUE INDEX "sale_order_number_key" ON "sale_order" USING btree ("store_id","number") WHERE not "sale_order"."test";--> statement-breakpoint
CREATE UNIQUE INDEX "sale_order_test_number_key" ON "sale_order" USING btree ("store_id","number") WHERE "sale_order"."test";
