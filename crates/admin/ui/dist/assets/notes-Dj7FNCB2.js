var e=`-- Schema for the SDK examples (TypeScript and Rust): private notes and a
-- private \`files\` bucket where each user writes under a folder named after
-- their id. Safe to run more than once.
--
-- Apply it to a development project as the database owner, either:
--   * copy it to migrations/V1__notes.sql (or the next free version) and run
--     \`nelcota migrate\`, or
--   * paste it into the SQL editor of the panel (/admin/).
--
-- It is not part of Nelcota's own migrations: Nelcota creates no business
-- tables in anyone's database.

CREATE TABLE IF NOT EXISTS public.notes (
    id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner      uuid        NOT NULL DEFAULT auth.uid(),
    body       text        NOT NULL,
    extra      jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;

-- anon gets no GRANT: without signing in, reads are denied.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notes TO authenticated;

DROP POLICY IF EXISTS notes_owner ON public.notes;
CREATE POLICY notes_owner ON public.notes FOR ALL TO authenticated
    USING (owner = auth.uid()) WITH CHECK (owner = auth.uid());

INSERT INTO storage.buckets (id, public) VALUES ('files', false)
    ON CONFLICT (id) DO NOTHING;

-- Each user reads and writes only files under \`<their user id>/\`.
DROP POLICY IF EXISTS notes_files_owner ON storage.objects;
CREATE POLICY notes_files_owner ON storage.objects FOR ALL TO authenticated
    USING (bucket_id = 'files' AND (storage.foldername(name))[1] = auth.uid()::text)
    WITH CHECK (bucket_id = 'files' AND (storage.foldername(name))[1] = auth.uid()::text);
`;export{e as default};