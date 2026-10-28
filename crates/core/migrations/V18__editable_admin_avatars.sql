-- Keep sources in the existing avatar row so legacy backups replace both.
ALTER TABLE nelcota.admin_avatar
    ADD COLUMN source_content_type text,
    ADD COLUMN source_image bytea,
    ADD COLUMN source_digest bytea,
    ADD COLUMN source_updated_at timestamptz,
    ADD COLUMN source_crop_x double precision,
    ADD COLUMN source_crop_y double precision,
    ADD COLUMN source_zoom double precision,
    ADD COLUMN source_rotation smallint,
    ADD CONSTRAINT admin_avatar_source_valid CHECK (
        (source_content_type IS NULL AND source_image IS NULL AND source_digest IS NULL
         AND source_updated_at IS NULL AND source_crop_x IS NULL AND source_crop_y IS NULL
         AND source_zoom IS NULL AND source_rotation IS NULL)
        OR
        (source_content_type IS NOT NULL AND source_content_type IN ('image/png', 'image/jpeg', 'image/webp')
         AND source_image IS NOT NULL AND octet_length(source_image) BETWEEN 1 AND 1048576
         AND source_digest IS NOT NULL AND octet_length(source_digest) = 32
         AND source_updated_at IS NOT NULL
         AND source_crop_x IS NOT NULL AND source_crop_x BETWEEN 0 AND 1
         AND source_crop_y IS NOT NULL AND source_crop_y BETWEEN 0 AND 1
         AND source_zoom IS NOT NULL AND source_zoom BETWEEN 1 AND 4
         AND source_rotation IS NOT NULL AND source_rotation IN (0, 90, 180, 270))
    );
