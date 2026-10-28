-- Bounded editor sources stay private and are removed with their avatar.
CREATE TABLE nelcota.admin_avatar_edits (
    email text PRIMARY KEY REFERENCES nelcota.admin_avatar(email) ON DELETE CASCADE,
    content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
    image bytea NOT NULL CHECK (octet_length(image) BETWEEN 1 AND 1048576),
    avatar_digest bytea NOT NULL CHECK (octet_length(avatar_digest) = 32),
    crop_x double precision NOT NULL CHECK (crop_x BETWEEN 0 AND 1),
    crop_y double precision NOT NULL CHECK (crop_y BETWEEN 0 AND 1),
    zoom double precision NOT NULL CHECK (zoom BETWEEN 1 AND 4),
    rotation smallint NOT NULL CHECK (rotation IN (0, 90, 180, 270))
);
REVOKE ALL ON nelcota.admin_avatar_edits FROM PUBLIC, anon, authenticated, service_role, nelcota_auth;
