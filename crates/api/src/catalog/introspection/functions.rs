//! PostgreSQL functions query and its row mapping.
use super::super::model::{Argument, Function};
use std::collections::BTreeMap;
use tokio_postgres::GenericClient;

pub(super) async fn load(
    client: &impl GenericClient,
    schema: &str,
) -> Result<BTreeMap<String, Vec<Function>>, tokio_postgres::Error> {
    let mut functions: BTreeMap<String, Vec<Function>> = BTreeMap::new();
    let rows = client
            .query(
                "SELECT p.proname::text,
                        coalesce(p.proargnames, '{}')::text[],
                        coalesce(p.proargmodes::text[], '{}'),
                        ARRAY(SELECT format_type(t, NULL) FROM unnest(p.proargtypes) t),
                        p.pronargdefaults::int4,
                        format_type(p.prorettype, NULL),
                        p.proretset,
                        p.prorettype = 'void'::regtype,
                        p.provolatile::text,
                        obj_description(p.oid, 'pg_proc'),
                        has_function_privilege('anon', p.oid, 'EXECUTE'),
                        has_function_privilege('authenticated', p.oid, 'EXECUTE'),
                        has_function_privilege('service_role', p.oid, 'EXECUTE')
                 FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = $1 AND p.prokind = 'f'
                   AND p.prorettype <> 'trigger'::regtype
                   AND p.prorettype <> 'event_trigger'::regtype
                   AND p.provariadic = 0
                   AND NOT EXISTS (
                       SELECT 1 FROM unnest(p.proargtypes) arg
                       JOIN pg_type t ON t.oid = arg
                       WHERE t.typtype = 'p')
                   AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
                 ORDER BY p.proname, p.proargtypes::text, p.proargnames",
                &[&schema],
            )
            .await?;
    'functions: for row in rows {
        let names: Vec<String> = row.get(1);
        let modes: Vec<String> = row.get(2);
        let types: Vec<String> = row.get(3);
        let defaults = usize::try_from(row.get::<_, i32>(4)).unwrap_or(0);
        // Names of the input arguments (modes i, b, v; no modes = all IN).
        let in_names: Vec<&String> = match modes.is_empty() {
            true => names.iter().collect(),
            false => names
                .iter()
                .zip(&modes)
                .filter(|(_, m)| matches!(m.as_str(), "i" | "b" | "v"))
                .map(|(n, _)| n)
                .collect(),
        };
        let mut args = Vec::with_capacity(types.len());
        let first_default = types.len().saturating_sub(defaults);
        for (i, type_name) in types.into_iter().enumerate() {
            // Only functions with named arguments are callable through JSON.
            let name = match in_names.get(i).filter(|n| !n.is_empty()) {
                Some(name) => name,
                _ => {
                    continue 'functions;
                }
            };
            args.push(Argument {
                name: (*name).clone(),
                type_name,
                has_default: i >= first_default,
            });
        }
        let function = Function {
            name: row.get(0),
            args,
            return_type: row.get(5),
            returns_set: row.get(6),
            returns_void: row.get(7),
            volatility: row.get::<_, String>(8).chars().next().unwrap_or('v'),
            comment: row.get(9),
            executable: [row.get(10), row.get(11), row.get(12)],
        };
        functions
            .entry(function.name.clone())
            .or_default()
            .push(function);
    }

    Ok(functions)
}
