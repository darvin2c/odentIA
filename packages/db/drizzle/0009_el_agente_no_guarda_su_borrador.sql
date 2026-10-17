-- El agente no guarda su borrador (ADR 0048). Las tablas de LangGraph las
-- creaba el worker al arrancar (`PostgresSaver.setup()`), fuera de esta
-- historia; nadie volvía a leerlas: cada turno arma el contexto desde la
-- base. Sus políticas de RLS se van con ellas. Solo se borran las que existen:
-- una base nueva nunca las tuvo y no deja avisos.
--
-- No hay clínicas reales todavía: no se conserva lo guardado.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['checkpoint_writes', 'checkpoint_blobs', 'checkpoints', 'checkpoint_migrations'] LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('DROP TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
