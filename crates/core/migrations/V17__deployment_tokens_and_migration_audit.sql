-- Deployment credentials are opaque, revocable and restricted to deployment routes.
CREATE TABLE nelcota.deploy_tokens (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    token_hash text NOT NULL UNIQUE,
    name text NOT NULL,
    issued_by text NOT NULL,
    issued_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz
);
CREATE TABLE nelcota.migration_audit (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    version int4 NOT NULL,
    name text NOT NULL,
    checksum text NOT NULL,
    actor text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON nelcota.deploy_tokens, nelcota.migration_audit FROM PUBLIC, anon, authenticated, service_role;
