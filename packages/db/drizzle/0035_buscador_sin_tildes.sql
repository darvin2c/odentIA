-- Buscador rápido, fase 0: «lucia» encuentra «Lucía» y cualquier pedazo de
-- palabra («profilax», «quis») en todas las pantallas. Los servicios comparan
-- con `search_fold` (packages/services/src/search-text.ts); las tablas que más
-- crecen llevan su índice de trigramas sobre la misma expresión.
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;--> statement-breakpoint
-- unaccent() no es IMMUTABLE porque depende del diccionario del search_path:
-- con el diccionario nombrado y el camino completo sí lo es, y puede indexarse.
CREATE OR REPLACE FUNCTION public.search_fold(value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$ SELECT lower(public.unaccent('public.unaccent'::regdictionary, value)) $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.search_digits(value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$ SELECT regexp_replace(value, '[^0-9]', '', 'g') $$;
--> statement-breakpoint
CREATE INDEX contact_search_name_idx ON public.contact USING gin (public.search_fold(display_name) public.gin_trgm_ops);--> statement-breakpoint
CREATE INDEX contact_search_phone_idx ON public.contact USING gin (public.search_digits(phone) public.gin_trgm_ops);--> statement-breakpoint
CREATE INDEX message_search_body_idx ON public.message USING gin (public.search_fold(body) public.gin_trgm_ops);--> statement-breakpoint
CREATE INDEX clinical_note_search_idx ON public.clinical_note USING gin (public.search_fold(note) public.gin_trgm_ops);
