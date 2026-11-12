-- Una «Nota del equipo» trasladada por la 0101 no es un contacto: con ella, la solicitud
-- dejaba de estar «por responder» y pasaba a «Contactada el…», aunque la nota dijera
-- «Pedirle a Ada que la llame». Se marca como nota (`from_note`) para que no cuente como
-- haberle respondido. Son las entradas que dejó el traslado: la primera de su solicitud,
-- con el texto de la nota, sin fecha para volver y visible para soporte. Al desplegar todo
-- junto son todas las que hay; en una base que ya corrió la 0101, las que se anotaron
-- después no se tocan.
--
-- La bitácora solo se agrega (`saas_follow_up_append_only`, 0101): el disparador se apaga
-- solo para esta marca, dentro de la transacción del despliegue, y vuelve a encenderse.
ALTER TABLE "admin"."saas_follow_up" DISABLE TRIGGER "saas_follow_up_append_only";--> statement-breakpoint
UPDATE "admin"."saas_follow_up" f
SET "from_note" = true
FROM "admin"."saas_waitlist_request" r
WHERE f."request_id" = r."id"
  AND f."body" = r."note"
  AND f."follow_up_on" IS NULL
  AND NOT f."admin_only"
  AND f."id" = (
    SELECT f2."id" FROM "admin"."saas_follow_up" f2
    WHERE f2."request_id" = r."id"
    ORDER BY f2."created_at", f2."id"
    LIMIT 1
  );--> statement-breakpoint
ALTER TABLE "admin"."saas_follow_up" ENABLE TRIGGER "saas_follow_up_append_only";
