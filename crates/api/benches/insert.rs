//! Run `cargo bench -p nelcota-api --bench insert` to measure batch compilation.
use nelcota_api::{
    catalog::{Column, Table, TableKind},
    query,
};
use serde_json::{Map, Value};
use std::{hint::black_box, time::Instant};

fn column(n: usize) -> Column {
    Column {
        name: format!("c{n:04}"),
        type_name: "integer".into(),
        full_type: "integer".into(),
        category: 'N',
        element_type: None,
        enum_values: vec![],
        nullable: true,
        has_default: false,
        generated: false,
        comment: None,
        privileges: Default::default(),
    }
}

fn main() {
    let row: Map<String, Value> = (1500..1600)
        .map(|n| (format!("c{n:04}"), Value::from(1)))
        .collect();
    let body = Value::Array(vec![Value::Object(row); 1000]);
    let bytes = serde_json::to_vec(&body).unwrap().len();
    for cols in [100, 400, 800, 1600] {
        let table = Table {
            name: "audit_wide".into(),
            kind: TableKind::Table,
            columns: (1600 - cols..1600).map(column).collect(),
            primary_key: vec![],
            foreign_keys: vec![],
            rls_enabled: false,
            rls_forced: false,
            security_invoker: false,
            comment: None,
            privileges: Default::default(),
        };
        for _ in 0..3 {
            let input = body.clone();
            let start = Instant::now();
            let sql = query::insert("public", &table, black_box(input), None, None).unwrap();
            black_box(sql);
            println!(
                "{cols} columns, {bytes} bytes, 1000 rows × 100 keys: {:?}",
                start.elapsed()
            );
        }
    }
}
