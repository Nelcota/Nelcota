//! TypeScript types generated from the catalog (`nelcota types`).
//!
//! The shape (`Database[schema]["Tables"][t]["Row" | "Insert" | "Update"]`)
//! follows the convention the ecosystem already knows, but it is plain
//! TypeScript: it depends on no SDK. `Relationships` lists each table's foreign
//! keys inside the exposed schema, which is what a typed client needs to know
//! whether an embed is an object (this table has the key) or an array (the
//! other table points here).

use std::fmt::Write;

use crate::catalog::{Catalog, Column, Function, Table, TableKind};

fn ts_scalar(type_name: &str) -> String {
    if let Some(element) = type_name.strip_suffix("[]") {
        return format!("({} | null)[]", ts_scalar(element));
    }
    match type_name {
        "smallint" | "integer" | "oid" => "number".into(),
        "bigint" | "real" | "double precision" | "numeric" => "number | string".into(),
        "boolean" => "boolean".into(),
        "json" | "jsonb" => "Json".into(),
        "void" => "undefined".into(),
        _ => "string".into(),
    }
}

fn ts_column(column: &Column) -> String {
    if !column.enum_values.is_empty() {
        let union = column
            .enum_values
            .iter()
            .map(|v| serde_json::to_string(v).unwrap_or_default())
            .collect::<Vec<_>>()
            .join(" | ");
        return match column.category == 'A' {
            true => {
                format!("({union} | null)[]")
            }
            false => union,
        };
    }
    ts_scalar(&column.type_name)
}

fn key(name: &str) -> String {
    let simple = name
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if simple {
        return name.to_owned();
    }
    serde_json::to_string(name).unwrap_or_default()
}

/// A TypeScript string literal (JSON escaping is valid TypeScript).
fn string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

fn string_tuple(values: &[String]) -> String {
    let items = values.iter().map(|v| string(v)).collect::<Vec<_>>();
    format!("[{}]", items.join(", "))
}

fn relationships(out: &mut String, catalog: &Catalog, table: &Table) {
    let keys: Vec<_> = table
        .foreign_keys
        .iter()
        .filter(|fk| {
            fk.foreign_schema == catalog.schema && catalog.tables.contains_key(&fk.foreign_table)
        })
        .collect();
    if keys.is_empty() {
        out.push_str(
            "        Relationships: [];
",
        );
        return;
    }
    out.push_str(
        "        Relationships: [
",
    );
    for fk in keys {
        let _ = writeln!(
            out,
            "          {{ foreignKeyName: {}; columns: {}; referencedRelation: {}; referencedColumns: {} }},",
            string(&fk.name),
            string_tuple(&fk.columns),
            string(&fk.foreign_table),
            string_tuple(&fk.foreign_columns),
        );
    }
    out.push_str(
        "        ];
",
    );
}

fn ts_named(catalog: &Catalog, type_name: &str) -> (String, bool) {
    if let Some(element) = type_name.strip_suffix("[]") {
        let (base, _) = ts_named(catalog, element);
        return (format!("({base} | null)[]"), false);
    }
    if let Some(named) = catalog.named_types.get(type_name) {
        let section = match (named.enum_values.is_empty(), named.relation.as_deref()) {
            (false, _) => "Enums",
            (true, Some(name)) => {
                if let Some(table) = catalog.tables.get(name) {
                    let section = match table.kind {
                        TableKind::Table => "Tables",
                        _ => "Views",
                    };
                    return (
                        format!(
                            "Database[{}][{}][{}][\"Row\"]",
                            string(&catalog.schema),
                            string(section),
                            string(name)
                        ),
                        true,
                    );
                }
                return ("unknown".into(), false);
            }
            _ => "CompositeTypes",
        };
        return (
            format!(
                "Database[{}][{}][{}]",
                string(&catalog.schema),
                string(section),
                string(&named.name)
            ),
            section == "CompositeTypes",
        );
    }
    // Preserve hand-built catalogs and pre-introspection fixtures.
    let table_name = type_name
        .strip_prefix(&format!("{}.", catalog.schema))
        .unwrap_or(type_name);
    if let Some(table) = catalog.tables.get(table_name) {
        let section = match table.kind {
            TableKind::Table => "Tables",
            _ => "Views",
        };
        return (
            format!(
                "Database[{}][{}][{}][\"Row\"]",
                string(&catalog.schema),
                string(section),
                string(&table.name)
            ),
            true,
        );
    }
    (ts_scalar(type_name), false)
}

fn function_signature(catalog: &Catalog, function: &Function) -> String {
    let args = function
        .args
        .iter()
        .map(|a| {
            let optional = match a.has_default {
                true => "?",
                false => "",
            };
            format!(
                "{}{optional}: {}",
                key(&a.name),
                ts_named(catalog, &a.type_name).0
            )
        })
        .collect::<Vec<_>>()
        .join("; ");
    let (base, relation) = ts_named(catalog, &function.return_type);
    let returns = match (function.returns_set, relation) {
        (false, _) => base,
        (true, true) => format!("{base}[]"),
        // Scalar sets can include NULL rows; group unions before `[]`.
        (true, false) => format!("({base} | null)[]"),
    };
    format!("{{ Args: {{ {args} }}; Returns: {returns} }}")
}

pub fn generate(catalog: &Catalog) -> String {
    let mut out = String::new();
    let schema = key(&catalog.schema);
    out.push_str("// Generated by `nelcota types`. Do not edit by hand.\n\n");
    out.push_str(
        "export type Json =\n  | string\n  | number\n  | boolean\n  | null\n  | { [key: string]: Json | undefined }\n  | Json[];\n\n",
    );
    let _ = writeln!(out, "export interface Database {{\n  {schema}: {{");

    for (section, views) in [("Tables", false), ("Views", true)] {
        let _ = writeln!(out, "    {section}: {{");
        for table in catalog
            .tables
            .values()
            .filter(|t| (t.kind != TableKind::Table) == views)
        {
            let _ = writeln!(out, "      {}: {{", key(&table.name));
            out.push_str("        Row: {\n");
            for c in &table.columns {
                let null = match c.nullable {
                    true => " | null",
                    false => "",
                };
                let _ = writeln!(out, "          {}: {}{null};", key(&c.name), ts_column(c));
            }
            out.push_str("        };\n");
            if table.kind != TableKind::MaterializedView {
                for (variant, all_optional) in [("Insert", false), ("Update", true)] {
                    let _ = writeln!(out, "        {variant}: {{");
                    for c in table.columns.iter().filter(|c| !c.generated) {
                        let optional = all_optional || c.nullable || c.has_default;
                        let null = match c.nullable {
                            true => " | null",
                            false => "",
                        };
                        let _ = writeln!(
                            out,
                            "          {}{}: {}{null};",
                            key(&c.name),
                            match optional {
                                true => "?",
                                false => "",
                            },
                            ts_column(c)
                        );
                    }
                    out.push_str("        };\n");
                }
            }
            relationships(&mut out, catalog, table);
            out.push_str("      };\n");
        }
        out.push_str("    };\n");
    }

    out.push_str("    Functions: {\n");
    for (name, overloads) in &catalog.functions {
        // Overloads become a union of signatures.
        let signatures: Vec<String> = overloads
            .iter()
            .map(|function| function_signature(catalog, function))
            .collect();
        let _ = writeln!(out, "      {}: {};", key(name), signatures.join(" | "));
    }
    out.push_str("    };\n");

    out.push_str("    Enums: {\n");
    let mut enums: Vec<(String, &Vec<String>)> = Vec::new();
    for table in catalog.tables.values() {
        for c in table.columns.iter().filter(|c| !c.enum_values.is_empty()) {
            let name = c
                .type_name
                .trim_end_matches("[]")
                .rsplit('.')
                .next()
                .unwrap_or_default()
                .trim_matches('"')
                .to_owned();
            if !enums.iter().any(|(n, _)| n == &name) {
                enums.push((name, &c.enum_values));
            }
        }
    }
    for named in catalog
        .named_types
        .values()
        .filter(|t| !t.enum_values.is_empty())
    {
        if !enums.iter().any(|(name, _)| name == &named.name) {
            enums.push((named.name.clone(), &named.enum_values));
        }
    }
    for (name, values) in enums {
        let union = values
            .iter()
            .map(|v| serde_json::to_string(v).unwrap_or_default())
            .collect::<Vec<_>>()
            .join(" | ");
        let _ = writeln!(out, "      {}: {union};", key(&name));
    }
    out.push_str("    };\n");
    let composites: Vec<_> = catalog
        .named_types
        .values()
        .filter(|t| t.enum_values.is_empty() && t.relation.is_none())
        .collect();
    if !composites.is_empty() {
        out.push_str("    CompositeTypes: {\n");
        for composite in composites {
            let _ = writeln!(out, "      {}: {{", key(&composite.name));
            for field in &composite.fields {
                let null = match field.nullable {
                    true => " | null",
                    false => "",
                };
                let _ = writeln!(
                    out,
                    "        {}: {}{null};",
                    key(&field.name),
                    ts_named(catalog, &field.type_name).0
                );
            }
            out.push_str("      };\n");
        }
        out.push_str("    };\n");
    }
    out.push_str("  };\n}\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{Argument, ForeignKey, Function, Privileges};

    #[test]
    fn precise_numbers_and_nullable_array_elements_in_every_write_shape() {
        assert_eq!(ts_scalar("bigint"), "number | string");
        assert_eq!(ts_scalar("numeric"), "number | string");
        assert_eq!(ts_scalar("numeric[]"), "(number | string | null)[]");
        assert_eq!(ts_scalar("text[]"), "(string | null)[]");
        let mut moods = column("moods", "public.mood[]");
        moods.category = 'A';
        moods.enum_values = vec!["happy".into(), "sad".into()];
        let mut catalog = Catalog {
            schema: "public".into(),
            ..Catalog::default()
        };
        catalog.tables.insert(
            "arrays".into(),
            table("arrays", vec![column("tags", "text[]"), moods], Vec::new()),
        );
        catalog.functions.insert(
            "echo_tags".into(),
            vec![Function {
                name: "echo_tags".into(),
                args: vec![Argument {
                    name: "tags".into(),
                    type_name: "text[]".into(),
                    has_default: false,
                }],
                return_type: "text[]".into(),
                returns_set: false,
                returns_void: false,
                volatility: 'i',
                comment: None,
                executable: [true; 3],
            }],
        );
        let out = generate(&catalog);
        // Row and Insert require the non-null array; Update makes it optional.
        assert_eq!(out.matches("tags: (string | null)[];").count(), 2);
        assert!(out.contains("tags?: (string | null)[];"), "{out}");
        assert_eq!(
            out.matches("moods: (\"happy\" | \"sad\" | null)[];")
                .count(),
            2
        );
        assert!(
            out.contains("moods?: (\"happy\" | \"sad\" | null)[];"),
            "{out}"
        );
        assert!(
            out.contains("Args: { tags: (string | null)[] }; Returns: (string | null)[]"),
            "{out}"
        );
    }

    fn column(name: &str, type_name: &str) -> Column {
        Column {
            name: name.into(),
            type_name: type_name.into(),
            full_type: type_name.into(),
            category: 'N',
            element_type: None,
            enum_values: Vec::new(),
            nullable: false,
            has_default: false,
            generated: false,
            comment: None,
            privileges: Default::default(),
        }
    }

    fn table(name: &str, columns: Vec<Column>, foreign_keys: Vec<ForeignKey>) -> Table {
        Table {
            name: name.into(),
            kind: TableKind::Table,
            columns,
            primary_key: vec!["id".into()],
            foreign_keys,
            rls_enabled: true,
            rls_forced: false,
            security_invoker: false,
            comment: None,
            privileges: [Privileges::default(); 3],
        }
    }

    fn foreign_key(name: &str, column: &str, schema: &str, target: &str) -> ForeignKey {
        ForeignKey {
            name: name.into(),
            columns: vec![column.into()],
            foreign_schema: schema.into(),
            foreign_table: target.into(),
            foreign_columns: vec!["id".into()],
        }
    }

    fn shop(schema: &str) -> Catalog {
        let mut catalog = Catalog {
            schema: schema.into(),
            ..Catalog::default()
        };
        catalog.tables.insert(
            "customers".into(),
            table("customers", vec![column("id", "bigint")], Vec::new()),
        );
        catalog.tables.insert(
            "orders".into(),
            table(
                "orders",
                vec![column("id", "bigint"), column("customer_id", "bigint")],
                vec![
                    foreign_key(
                        "orders_customer_id_fkey",
                        "customer_id",
                        schema,
                        "customers",
                    ),
                    // Outside the exposed schema: not embeddable, not listed.
                    foreign_key("orders_audit_fkey", "id", "audit", "events"),
                ],
            ),
        );
        catalog.functions.insert(
            "recent_orders".into(),
            vec![Function {
                name: "recent_orders".into(),
                args: vec![Argument {
                    name: "since".into(),
                    type_name: "timestamptz".into(),
                    has_default: true,
                }],
                return_type: format!("{schema}.orders"),
                returns_set: true,
                returns_void: false,
                volatility: 's',
                comment: None,
                executable: [true; 3],
            }],
        );
        catalog
    }

    #[test]
    fn relationships_list_foreign_keys_inside_the_schema() {
        let out = generate(&shop("public"));
        assert!(
            out.contains(
                r#"{ foreignKeyName: "orders_customer_id_fkey"; columns: ["customer_id"]; referencedRelation: "customers"; referencedColumns: ["id"] },"#
            ),
            "{out}"
        );
        assert!(!out.contains("orders_audit_fkey"), "{out}");
        assert!(out.contains("Relationships: [];"), "{out}");
    }

    #[test]
    fn function_rows_refer_to_the_table_with_plain_string_keys() {
        let out = generate(&shop("public"));
        assert!(
            out.contains(r#"Returns: Database["public"]["Tables"]["orders"]["Row"][]"#),
            "{out}"
        );
        let out = generate(&shop("my-app"));
        assert!(out.contains(r#"  "my-app": {"#), "{out}");
        assert!(
            out.contains(r#"Returns: Database["my-app"]["Tables"]["orders"]["Row"][]"#),
            "{out}"
        );
    }

    #[test]
    fn scalar_sets_group_unions_and_allow_null_elements() {
        let mut catalog = shop("public");
        let prototype = catalog.functions["recent_orders"][0].clone();
        for (name, return_type) in [
            ("numeric_samples", "numeric"),
            ("bigint_samples", "bigint"),
            ("array_samples", "text[]"),
        ] {
            catalog.functions.insert(
                name.into(),
                vec![Function {
                    name: name.into(),
                    args: Vec::new(),
                    return_type: return_type.into(),
                    ..prototype.clone()
                }],
            );
        }
        let out = generate(&catalog);
        for name in ["numeric_samples", "bigint_samples"] {
            assert!(
                out.contains(&format!(
                    "{name}: {{ Args: {{  }}; Returns: (number | string | null)[] }}"
                )),
                "{out}"
            );
        }
        assert!(
            out.contains("array_samples: { Args: {  }; Returns: ((string | null)[] | null)[] }"),
            "{out}"
        );
    }

    #[test]
    fn function_rows_refer_to_views_in_the_views_section() {
        let mut catalog = shop("my-app");
        let prototype = catalog.functions["recent_orders"][0].clone();
        for (name, kind, returns_set) in [
            ("order_view", TableKind::View, true),
            ("materialized_orders", TableKind::MaterializedView, true),
            ("foreign_orders", TableKind::ForeignTable, false),
        ] {
            let mut relation = table(name, vec![column("id", "bigint")], Vec::new());
            relation.kind = kind;
            catalog.tables.insert(name.into(), relation);
            catalog.functions.insert(
                format!("read_{name}"),
                vec![Function {
                    name: format!("read_{name}"),
                    args: Vec::new(),
                    return_type: format!("my-app.{name}"),
                    returns_set,
                    ..prototype.clone()
                }],
            );
        }
        let out = generate(&catalog);
        for (name, suffix) in [
            ("order_view", "[]"),
            ("materialized_orders", "[]"),
            ("foreign_orders", ""),
        ] {
            assert!(
                out.contains(&format!(
                    "read_{name}: {{ Args: {{  }}; Returns: Database[\"my-app\"][\"Views\"][\"{name}\"][\"Row\"]{suffix} }}"
                )),
                "{out}"
            );
        }
    }

    #[test]
    fn overloaded_rpc_signatures_preserve_exact_output() {
        let mut catalog = shop("my-app");
        let prototype = catalog.functions.remove("recent_orders").unwrap().remove(0);
        let mut view = table("order-view", Vec::new(), Vec::new());
        view.kind = TableKind::View;
        catalog.tables.insert(view.name.clone(), view);
        let mut overloads = Vec::new();
        for (return_type, returns_set) in [
            ("my-app.orders", true),
            ("orders", false),
            ("my-app.order-view", true),
            ("numeric", true),
            ("text[]", true),
            ("void", false),
        ] {
            overloads.push(Function {
                name: "lookup-\"rpc".into(),
                args: Vec::new(),
                return_type: return_type.into(),
                returns_set,
                returns_void: return_type == "void",
                ..prototype.clone()
            });
        }
        overloads[0].args = vec![
            Argument {
                name: "order-id".into(),
                type_name: "integer".into(),
                has_default: false,
            },
            Argument {
                name: "tags".into(),
                type_name: "text[]".into(),
                has_default: true,
            },
        ];
        catalog.functions.insert("lookup-\"rpc".into(), overloads);
        let out = generate(&catalog);
        let functions = out
            .split_once("    Functions: {\n")
            .unwrap()
            .1
            .split_once("    Enums: {\n")
            .unwrap()
            .0;
        assert_eq!(
            functions,
            concat!(
                "      \"lookup-\\\"rpc\": { Args: { \"order-id\": number; tags?: (string | null)[] }; ",
                "Returns: Database[\"my-app\"][\"Tables\"][\"orders\"][\"Row\"][] } | ",
                "{ Args: {  }; Returns: Database[\"my-app\"][\"Tables\"][\"orders\"][\"Row\"] } | ",
                "{ Args: {  }; Returns: Database[\"my-app\"][\"Views\"][\"order-view\"][\"Row\"][] } | ",
                "{ Args: {  }; Returns: (number | string | null)[] } | ",
                "{ Args: {  }; Returns: ((string | null)[] | null)[] } | ",
                "{ Args: {  }; Returns: undefined };\n",
                "    };\n",
            )
        );
    }
}
