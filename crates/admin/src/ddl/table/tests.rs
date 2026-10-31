//! Characterization of table SQL, validation order and working-schema changes.
use super::*;
use crate::ddl::{ApiRole, GrantDef, Privilege};
use crate::tables::structure::{ColumnInfo, ForeignKeyRef, Structure};
use serde_json::json;

const ENUMS: &[String] = &[];

fn ctx() -> Context<'static> {
    Context {
        schema: "public",
        enums: ENUMS,
    }
}

fn col(name: &str, data_type: &str) -> ColumnDef {
    ColumnDef {
        name: name.into(),
        data_type: data_type.into(),
        nullable: true,
        default: None,
        primary_key: false,
        identity: false,
        unique: false,
        references: None,
        comment: None,
    }
}

fn spec(columns: Vec<ColumnDef>) -> CreateTable {
    CreateTable {
        name: "notes".into(),
        comment: None,
        columns,
        rls: true,
        grants: vec![],
    }
}

#[test]
fn creates_a_table_with_pk_identity_default_fk_rls_comments_and_grants() {
    let mut table = spec(vec![
        ColumnDef {
            primary_key: true,
            identity: true,
            ..col("id", "bigint")
        },
        ColumnDef {
            nullable: false,
            ..col("body", "text")
        },
        ColumnDef {
            default: Some("now()".into()),
            nullable: false,
            ..col("created_at", "timestamptz")
        },
        ColumnDef {
            unique: true,
            ..col("slug", "varchar(80)")
        },
        ColumnDef {
            references: Some(ReferenceDef {
                table: "customers".into(),
                column: "id".into(),
                on_delete: OnDelete::Cascade,
            }),
            comment: Some("owner of the note".into()),
            ..col("customer_id", "bigint")
        },
    ]);
    table.comment = Some("The team's notes".into());
    table.grants = vec![
        GrantDef {
            role: ApiRole::Authenticated,
            privileges: vec![Privilege::Select, Privilege::Insert],
        },
        GrantDef {
            role: ApiRole::Anon,
            privileges: vec![],
        },
    ];
    assert_eq!(
        create(&ctx(), &table).unwrap(),
        [
            "CREATE TABLE \"public\".\"notes\" (\n  \
                 \"id\" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n  \
                 \"body\" text NOT NULL,\n  \
                 \"created_at\" timestamptz NOT NULL DEFAULT (now()),\n  \
                 \"slug\" varchar(80) UNIQUE,\n  \
                 \"customer_id\" bigint REFERENCES \"public\".\"customers\" (\"id\") ON DELETE CASCADE\n)",
            "ALTER TABLE \"public\".\"notes\" ENABLE ROW LEVEL SECURITY",
            "COMMENT ON TABLE \"public\".\"notes\" IS 'The team''s notes'",
            "COMMENT ON COLUMN \"public\".\"notes\".\"customer_id\" IS 'owner of the note'",
            "GRANT SELECT, INSERT ON TABLE \"public\".\"notes\" TO \"authenticated\"",
        ]
    );
}

#[test]
fn composite_primary_key_becomes_a_table_constraint() {
    let table = spec(vec![
        ColumnDef {
            primary_key: true,
            ..col("a", "integer")
        },
        ColumnDef {
            primary_key: true,
            ..col("b", "integer")
        },
    ]);
    let sql = &create(&ctx(), &table).unwrap()[0];
    assert!(sql.contains("\"a\" integer NOT NULL"), "{sql}");
    assert!(sql.ends_with("PRIMARY KEY (\"a\", \"b\")\n)"), "{sql}");
}

#[test]
fn no_rls_when_asked() {
    let mut table = spec(vec![col("x", "text")]);
    table.rls = false;
    assert_eq!(create(&ctx(), &table).unwrap().len(), 1);
}

#[test]
fn creation_refuses_invalid_specifications() {
    let cases = [
        spec(vec![]),
        spec(vec![col("x", "text"), col("x", "integer")]),
        spec(vec![ColumnDef {
            identity: true,
            ..col("id", "text")
        }]),
        spec(vec![ColumnDef {
            identity: true,
            default: Some("1".into()),
            ..col("id", "bigint")
        }]),
        spec(vec![ColumnDef {
            default: Some("  ".into()),
            ..col("x", "text")
        }]),
        spec(vec![col("x", "money")]),
    ];
    for case in cases {
        assert!(create(&ctx(), &case).is_err(), "{case:?}");
    }
    let err = create(&ctx(), &spec(vec![col("x", "text"), col("x", "integer")])).unwrap_err();
    assert_eq!(err.code, "duplicate_column");
    assert_eq!(err.params, json!({ "column": "x" }));
}

fn structure() -> Structure {
    let info = |name: &str| ColumnInfo {
        name: name.into(),
        data_type: "text".into(),
        nullable: true,
        default: None,
        identity: None,
        generated: false,
        primary_key: false,
        unique: None,
        references: None,
        comment: None,
    };
    Structure {
        name: "notes".into(),
        comment: None,
        rls_enabled: true,
        primary_key: vec!["id".into()],
        primary_key_constraint: Some("notes_pkey".into()),
        columns: vec![
            ColumnInfo {
                identity: Some("always"),
                primary_key: true,
                ..info("id")
            },
            ColumnInfo {
                unique: Some("notes_slug_key".into()),
                ..info("slug")
            },
            ColumnInfo {
                references: Some(ForeignKeyRef {
                    table: "customers".into(),
                    column: "id".into(),
                    on_delete: "no action",
                    constraint: "notes_customer_id_fkey".into(),
                }),
                ..info("customer_id")
            },
            info("body"),
        ],
        grants: vec![],
    }
}

#[test]
fn column_changes() {
    let actions = vec![
        AlterAction::AddColumn {
            column: ColumnDef {
                default: Some("0".into()),
                ..col("votes", "integer")
            },
        },
        AlterAction::SetType {
            column: "body".into(),
            data_type: "varchar(200)".into(),
            using: None,
        },
        AlterAction::SetNullable {
            column: "body".into(),
            nullable: false,
        },
        AlterAction::SetDefault {
            column: "body".into(),
            default: Some("''".into()),
        },
        AlterAction::RenameColumn {
            from: "body".into(),
            to: "content".into(),
        },
        AlterAction::DropColumn {
            name: "slug".into(),
        },
    ];
    assert_eq!(
        alter(&ctx(), &structure(), &actions).unwrap(),
        [
            "ALTER TABLE \"public\".\"notes\" ADD COLUMN \"votes\" integer DEFAULT (0)",
            "ALTER TABLE \"public\".\"notes\" ALTER COLUMN \"body\" TYPE varchar(200) USING \"body\"::varchar(200)",
            "ALTER TABLE \"public\".\"notes\" ALTER COLUMN \"body\" SET NOT NULL",
            "ALTER TABLE \"public\".\"notes\" ALTER COLUMN \"body\" SET DEFAULT ('')",
            "ALTER TABLE \"public\".\"notes\" RENAME COLUMN \"body\" TO \"content\"",
            "ALTER TABLE \"public\".\"notes\" DROP COLUMN \"slug\"",
        ]
    );
}

#[test]
fn later_actions_see_renamed_added_and_dropped_columns() {
    let actions = vec![
        AlterAction::RenameColumn {
            from: "body".into(),
            to: "content".into(),
        },
        AlterAction::SetNullable {
            column: "content".into(),
            nullable: false,
        },
        AlterAction::AddColumn {
            column: col("votes", "integer"),
        },
        AlterAction::SetDefault {
            column: "votes".into(),
            default: Some("0".into()),
        },
        AlterAction::DropColumn {
            name: "slug".into(),
        },
    ];
    assert_eq!(alter(&ctx(), &structure(), &actions).unwrap().len(), 5);

    let stale = vec![
        AlterAction::RenameColumn {
            from: "body".into(),
            to: "content".into(),
        },
        AlterAction::SetNullable {
            column: "body".into(),
            nullable: false,
        },
    ];
    assert!(
        alter(&ctx(), &structure(), &stale).is_err(),
        "the old name no longer applies"
    );
    let dropped = vec![
        AlterAction::DropColumn {
            name: "slug".into(),
        },
        AlterAction::SetUnique {
            column: "slug".into(),
            unique: true,
        },
    ];
    assert!(alter(&ctx(), &structure(), &dropped).is_err());
}

#[test]
fn constraints_use_the_current_names() {
    let actions = vec![
        AlterAction::SetUnique {
            column: "slug".into(),
            unique: false,
        },
        AlterAction::SetUnique {
            column: "body".into(),
            unique: true,
        },
        // Already unique: nothing to do.
        AlterAction::SetUnique {
            column: "body".into(),
            unique: true,
        },
        AlterAction::SetReference {
            column: "customer_id".into(),
            reference: Some(ReferenceDef {
                table: "customers".into(),
                column: "id".into(),
                on_delete: OnDelete::SetNull,
            }),
        },
    ];
    let sql = alter(&ctx(), &structure(), &actions).unwrap();
    assert_eq!(
        sql[0],
        "ALTER TABLE \"public\".\"notes\" DROP CONSTRAINT \"notes_slug_key\""
    );
    assert!(
        sql[1].starts_with("ALTER TABLE \"public\".\"notes\" ADD CONSTRAINT \"nelcota_unique_")
    );
    assert!(sql[1].ends_with(" UNIQUE (\"body\")"));
    assert_eq!(
        sql[2],
        "ALTER TABLE \"public\".\"notes\" DROP CONSTRAINT \"notes_customer_id_fkey\""
    );
    assert_eq!(
        sql[3],
        "ALTER TABLE \"public\".\"notes\" ADD FOREIGN KEY (\"customer_id\") REFERENCES \"public\".\"customers\" (\"id\") ON DELETE SET NULL"
    );
}

#[test]
fn renaming_the_table_applies_to_the_following_statements() {
    let actions = vec![
        AlterAction::RenameTable {
            name: "annotations".into(),
        },
        AlterAction::SetRls { enabled: false },
        AlterAction::SetGrants {
            grant: GrantDef {
                role: ApiRole::Anon,
                privileges: vec![Privilege::Select],
            },
        },
    ];
    assert_eq!(
        alter(&ctx(), &structure(), &actions).unwrap(),
        [
            "ALTER TABLE \"public\".\"notes\" RENAME TO \"annotations\"",
            "ALTER TABLE \"public\".\"annotations\" DISABLE ROW LEVEL SECURITY",
            "REVOKE ALL ON TABLE \"public\".\"annotations\" FROM \"anon\"",
            "GRANT SELECT ON TABLE \"public\".\"annotations\" TO \"anon\"",
        ]
    );
}

#[test]
fn alter_refuses_what_makes_no_sense() {
    let cases = vec![
        vec![],
        vec![AlterAction::DropColumn {
            name: "missing".into(),
        }],
        vec![AlterAction::AddColumn {
            column: col("body", "text"),
        }],
        vec![AlterAction::AddColumn {
            column: ColumnDef {
                primary_key: true,
                ..col("new", "text")
            },
        }],
        vec![AlterAction::SetDefault {
            column: "id".into(),
            default: Some("1".into()),
        }],
        vec![AlterAction::SetType {
            column: "body".into(),
            data_type: "money".into(),
            using: None,
        }],
    ];
    for actions in cases {
        assert!(
            alter(&ctx(), &structure(), &actions).is_err(),
            "{actions:?}"
        );
    }
}

#[test]
fn drop_with_and_without_cascade() {
    assert_eq!(
        drop("public", "notes", TableKind::Table, false),
        ["DROP TABLE \"public\".\"notes\""]
    );
    assert_eq!(
        drop("public", "notes", TableKind::Table, true),
        ["DROP TABLE \"public\".\"notes\" CASCADE"]
    );
}

#[test]
fn drop_matches_the_relation_kind() {
    for (kind, statement) in [
        (TableKind::View, "DROP VIEW"),
        (TableKind::MaterializedView, "DROP MATERIALIZED VIEW"),
        (TableKind::ForeignTable, "DROP FOREIGN TABLE"),
    ] {
        assert_eq!(
            drop("public", "report", kind, true),
            [format!("{statement} \"public\".\"report\" CASCADE")]
        );
    }
}
