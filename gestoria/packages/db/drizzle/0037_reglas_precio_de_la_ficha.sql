-- Las reglas del precio de la ficha (lienzo «La ficha del producto»). Lo cambia quien cambia el
-- catálogo (`configuracion`, en el servidor); el agente solo lo lee: las reglas restrictivas de
-- `0007_reglas_sofi.sql` sobre `product` y `product_promotion` ya le niegan cambiarlo.
GRANT UPDATE (wholesale_min_quantity, wholesale_price_cents, combo_percent_off, offer_delivery, offer_discount, offer_second_unit, offer_gift) ON TABLE product TO gestoria_app;--> statement-breakpoint
GRANT UPDATE (option_index, option_value) ON TABLE product_promotion TO gestoria_app;
