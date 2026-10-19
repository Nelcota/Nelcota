//! Characterize PostgreSQL metadata before reorganizing its readers.
mod common;

use common::TestApp;
use nelcota_api::{Catalog, catalog::TableKind};
use nelcota_core::Role;

#[tokio::test]
async fn metadata_preserves_order_flags_privileges_and_rpc_arguments() {
    let app = TestApp::spawn().await;
    app.admin_client
        .batch_execute(
            "CREATE SCHEMA metadata_contract;
             CREATE TYPE metadata_contract.priority AS ENUM ('low', 'high');
             CREATE TABLE metadata_contract.parents (
                 tenant integer, id bigint, PRIMARY KEY (tenant, id)
             );
             ALTER TABLE metadata_contract.parents ENABLE ROW LEVEL SECURITY;
             ALTER TABLE metadata_contract.parents FORCE ROW LEVEL SECURITY;
             COMMENT ON TABLE metadata_contract.parents IS 'Parent records';
             CREATE TABLE metadata_contract.children (
                 id integer GENERATED ALWAYS AS IDENTITY,
                 tenant integer NOT NULL,
                 parent_id bigint,
                 priority metadata_contract.priority NOT NULL DEFAULT 'low',
                 labels metadata_contract.priority[],
                 amount numeric(12,3),
                 doubled integer GENERATED ALWAYS AS (tenant * 2) STORED,
                 CONSTRAINT parent_reference FOREIGN KEY (tenant, parent_id)
                     REFERENCES metadata_contract.parents (tenant, id)
             );
             COMMENT ON COLUMN metadata_contract.children.amount IS 'Exact amount';
             CREATE VIEW metadata_contract.visible_children WITH (security_invoker = true)
                 AS SELECT * FROM metadata_contract.children;
             CREATE MATERIALIZED VIEW metadata_contract.cached_children
                 AS SELECT * FROM metadata_contract.children WITH NO DATA;
             GRANT USAGE ON SCHEMA metadata_contract TO anon, authenticated, service_role;
             GRANT SELECT ON metadata_contract.parents TO anon;
             GRANT SELECT, INSERT, UPDATE ON metadata_contract.children TO authenticated;
             GRANT ALL ON metadata_contract.parents, metadata_contract.children TO service_role;
             CREATE FUNCTION metadata_contract.named(value integer, suffix text DEFAULT 'x')
                 RETURNS text LANGUAGE sql STABLE AS $$ SELECT value::text || suffix $$;
             COMMENT ON FUNCTION metadata_contract.named(integer, text) IS 'Named arguments';
             REVOKE ALL ON FUNCTION metadata_contract.named(integer, text) FROM PUBLIC;
             GRANT EXECUTE ON FUNCTION metadata_contract.named(integer, text) TO authenticated;
             CREATE FUNCTION metadata_contract.output(IN value integer, OUT result integer)
                 LANGUAGE sql IMMUTABLE AS $$ SELECT value $$;
             CREATE FUNCTION metadata_contract.unnamed(integer)
                 RETURNS integer LANGUAGE sql AS $$ SELECT $1 $$;
             CREATE FUNCTION metadata_contract.rows(value integer)
                 RETURNS SETOF integer LANGUAGE sql AS $$ SELECT value $$;
             CREATE FUNCTION metadata_contract.nothing()
                 RETURNS void LANGUAGE sql AS $$ SELECT $$;",
        )
        .await
        .unwrap();
    let catalog = Catalog::load(&app.admin_client, "metadata_contract")
        .await
        .unwrap();
    assert_eq!(catalog.schema, "metadata_contract");
    assert_eq!(catalog.tables.len(), 4);
    let parent = &catalog.tables["parents"];
    assert_eq!(parent.kind, TableKind::Table);
    assert_eq!(parent.primary_key, ["tenant", "id"]);
    assert_eq!(parent.comment.as_deref(), Some("Parent records"));
    assert!(parent.rls_enabled && parent.rls_forced);
    let anon = parent.privileges_for(Role::Anon);
    assert!(anon.select && !anon.insert && !anon.update && !anon.delete);
    assert!(!parent.privileges_for(Role::Authenticated).select);
    assert!(parent.privileges_for(Role::ServiceRole).delete);
    let child = &catalog.tables["children"];
    assert_eq!(
        child
            .columns
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>(),
        [
            "id",
            "tenant",
            "parent_id",
            "priority",
            "labels",
            "amount",
            "doubled"
        ]
    );
    let identity = child.column("id").unwrap();
    assert!(identity.generated && identity.has_default && !identity.nullable);
    assert!(child.column("doubled").unwrap().generated);
    let priority = child.column("priority").unwrap();
    assert_eq!(priority.enum_values, ["low", "high"]);
    assert!(priority.has_default && !priority.nullable);
    let labels = child.column("labels").unwrap();
    assert_eq!(labels.category, 'A');
    assert_eq!(labels.enum_values, ["low", "high"]);
    assert!(
        labels
            .element_type
            .as_deref()
            .unwrap()
            .ends_with("priority")
    );
    let amount = child.column("amount").unwrap();
    assert_eq!(amount.full_type, "numeric(12,3)");
    assert_eq!(amount.comment.as_deref(), Some("Exact amount"));
    assert_eq!(child.foreign_keys.len(), 1);
    let reference = &child.foreign_keys[0];
    assert_eq!(reference.name, "parent_reference");
    assert_eq!(reference.columns, ["tenant", "parent_id"]);
    assert_eq!(reference.foreign_schema, "metadata_contract");
    assert_eq!(reference.foreign_table, "parents");
    assert_eq!(reference.foreign_columns, ["tenant", "id"]);
    assert!(!child.privileges_for(Role::Anon).select);
    let authenticated = child.privileges_for(Role::Authenticated);
    assert!(authenticated.select && authenticated.insert && authenticated.update);
    assert!(!authenticated.delete);
    assert!(catalog.tables["visible_children"].security_invoker);
    assert_eq!(catalog.tables["visible_children"].kind, TableKind::View);
    assert_eq!(
        catalog.tables["cached_children"].kind,
        TableKind::MaterializedView
    );
    assert!(!catalog.functions.contains_key("unnamed"));
    let named = &catalog.functions["named"][0];
    assert_eq!(named.args.len(), 2);
    assert_eq!(named.args[0].name, "value");
    assert!(!named.args[0].has_default);
    assert_eq!(named.args[1].name, "suffix");
    assert!(named.args[1].has_default);
    assert_eq!(named.volatility, 's');
    assert_eq!(named.comment.as_deref(), Some("Named arguments"));
    assert_eq!(named.executable, [false, true, false]);
    let output = &catalog.functions["output"][0];
    assert_eq!(output.args.len(), 1);
    assert_eq!(output.args[0].name, "value");
    assert_eq!(output.volatility, 'i');
    assert!(catalog.functions["rows"][0].returns_set);
    assert!(catalog.functions["nothing"][0].returns_void);
}
