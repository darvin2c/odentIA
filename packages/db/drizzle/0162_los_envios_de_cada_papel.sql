-- Si un papel le llegó se lee de sus envíos (el presupuesto en cada lista y en «Te espera»):
-- sin índice, cada lectura recorría el registro de toda la clínica. Parcial, solo las dos acciones de
-- envío, para que sea chico y no pese en cada escritura del registro. No va CONCURRENTLY porque el
-- migrador corre cada migración en una transacción: mientras se arma, las escrituras en audit_event
-- esperan una lectura de la tabla.
CREATE INDEX "audit_event_sent_document_idx" ON "audit_event" USING btree ("organization_id",("metadata"->>'documentId'),"created_at") WHERE "audit_event"."action" in ('financial_document.sent', 'health_document.sent');