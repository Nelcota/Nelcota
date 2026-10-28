//! RLS policy DDL.
//!
//! Editing = `DROP` + `CREATE` in the same transaction: `ALTER POLICY` changes
//! neither the command (`FOR SELECT` → `FOR UPDATE`) nor the kind
//! (permissive/restrictive).

use nelcota_api::query::ident;
use serde::Deserialize;
use serde_json::{Value, json};

use super::{Result, expression, invalid, qualified, validate_name};

/// Existing records keep a NULL owner: assigning them to the administrator
/// would be incorrect. New API records receive the signed-in user's ID.
pub fn add_owner_column(schema: &str, table: &str, column: &str) -> Result<Vec<String>> {
    validate_name("column", column)?;
    Ok(vec![format!(
        "ALTER TABLE {} ADD COLUMN {} uuid DEFAULT auth.uid()",
        qualified(schema, table),
        ident(column)
    )])
}

/// Additive grants: existing permissions are retained. All statements run in
/// the same transaction as the policy, so a failed rule cannot leave access open.
pub fn prepare_access(schema: &str, table: &str, def: &PolicyDef) -> Vec<String> {
    use super::{ApiRole, GrantDef, Privilege, grant};
    let table = qualified(schema, table);
    let mut statements = vec![format!("ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")];
    let privileges = match def.command {
        Command::Select => vec![Privilege::Select],
        Command::Insert => vec![Privilege::Insert],
        Command::Update => vec![Privilege::Select, Privilege::Update],
        Command::Delete => vec![Privilege::Select, Privilege::Delete],
        Command::All => vec![
            Privilege::Select,
            Privilege::Insert,
            Privilege::Update,
            Privilege::Delete,
        ],
    };
    let public = def.roles.is_empty() || def.roles.contains(&PolicyRole::Public);
    for (policy_role, api_role) in [
        (PolicyRole::Anon, ApiRole::Anon),
        (PolicyRole::Authenticated, ApiRole::Authenticated),
        (PolicyRole::ServiceRole, ApiRole::ServiceRole),
    ] {
        if public || def.roles.contains(&policy_role) {
            statements.extend(grant(
                &table,
                &GrantDef {
                    role: api_role,
                    privileges: privileges.clone(),
                },
            ));
        }
    }
    statements
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, ts_rs::TS, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Command {
    All,
    Select,
    Insert,
    Update,
    Delete,
}

impl Command {
    fn as_sql(self) -> &'static str {
        match self {
            Command::All => "ALL",
            Command::Select => "SELECT",
            Command::Insert => "INSERT",
            Command::Update => "UPDATE",
            Command::Delete => "DELETE",
        }
    }

    /// INSERT only has the new row (WITH CHECK); SELECT/DELETE only the existing one (USING).
    fn accepts_using(self) -> bool {
        self != Command::Insert
    }

    fn accepts_check(self) -> bool {
        !matches!(self, Command::Select | Command::Delete)
    }
}

/// `public` = every role.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, ts_rs::TS, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PolicyRole {
    Public,
    Anon,
    Authenticated,
    ServiceRole,
}

impl PolicyRole {
    fn as_sql(self) -> String {
        match self {
            // PUBLIC is a keyword, not a role: it goes unquoted.
            PolicyRole::Public => "PUBLIC".to_owned(),
            PolicyRole::Anon => ident("anon"),
            PolicyRole::Authenticated => ident("authenticated"),
            PolicyRole::ServiceRole => ident("service_role"),
        }
    }
}

const fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, ts_rs::TS, schemars::JsonSchema)]
pub struct PolicyDef {
    pub name: String,
    pub command: Command,
    /// Empty = `PUBLIC`.
    #[serde(default)]
    pub roles: Vec<PolicyRole>,
    #[serde(default = "yes")]
    pub permissive: bool,
    /// Which existing rows the role sees/changes.
    pub using: Option<String>,
    /// Which new/changed rows are accepted.
    pub check: Option<String>,
}

fn non_empty(text: &Option<String>) -> Option<&str> {
    text.as_deref().map(str::trim).filter(|t| !t.is_empty())
}

pub fn create(schema: &str, table: &str, def: &PolicyDef) -> Result<Vec<String>> {
    validate_name("policy", &def.name)?;
    let using = non_empty(&def.using);
    let check = non_empty(&def.check);
    if using.is_some() && !def.command.accepts_using() {
        return invalid(
            "policy_insert_no_using",
            "an INSERT policy does not use USING: the row does not exist yet (use WITH CHECK)",
            Value::Null,
        );
    }
    if check.is_some() && !def.command.accepts_check() {
        let command = def.command.as_sql();
        return invalid(
            "policy_check_not_allowed",
            format!("a {command} policy does not use WITH CHECK: no row is written (use USING)"),
            json!({ "command": command }),
        );
    }
    match def.command {
        Command::Insert if check.is_none() => {
            return invalid(
                "policy_insert_needs_check",
                "an INSERT policy needs WITH CHECK",
                Value::Null,
            );
        }
        Command::Insert => {}
        _ if using.is_none() => {
            return invalid(
                "policy_needs_using",
                "the policy needs a USING expression",
                Value::Null,
            );
        }
        _ => {}
    }

    let mut roles: Vec<String> = Vec::new();
    for role in &def.roles {
        let sql = role.as_sql();
        if !roles.contains(&sql) {
            roles.push(sql);
        }
    }
    if roles.is_empty() || def.roles.contains(&PolicyRole::Public) {
        roles = vec!["PUBLIC".to_owned()];
    }

    let mut sql = format!(
        "CREATE POLICY {} ON {} AS {} FOR {} TO {}",
        ident(&def.name),
        qualified(schema, table),
        match def.permissive {
            true => "PERMISSIVE",
            false => "RESTRICTIVE",
        },
        def.command.as_sql(),
        roles.join(", ")
    );
    if let Some(using) = using {
        sql.push_str(&format!(" USING {}", expression("USING", using)?));
    }
    if let Some(check) = check {
        sql.push_str(&format!(" WITH CHECK {}", expression("WITH CHECK", check)?));
    }
    Ok(vec![sql])
}

pub fn drop(schema: &str, table: &str, name: &str) -> Result<Vec<String>> {
    validate_name("policy", name)?;
    Ok(vec![format!(
        "DROP POLICY {} ON {}",
        ident(name),
        qualified(schema, table)
    )])
}

/// Replaces the policy `original` with the new definition (the name may change).
pub fn replace(schema: &str, table: &str, original: &str, def: &PolicyDef) -> Result<Vec<String>> {
    let mut statements = drop(schema, table, original)?;
    statements.extend(create(schema, table, def)?);
    Ok(statements)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def(command: Command, using: Option<&str>, check: Option<&str>) -> PolicyDef {
        PolicyDef {
            name: "owner".into(),
            command,
            roles: vec![PolicyRole::Authenticated],
            permissive: true,
            using: using.map(Into::into),
            check: check.map(Into::into),
        }
    }

    #[test]
    fn creates_a_policy_with_using_and_check() {
        let policy = def(
            Command::All,
            Some("owner = auth.uid()"),
            Some("owner = auth.uid()"),
        );
        assert_eq!(
            create("public", "notes", &policy).unwrap(),
            [
                "CREATE POLICY \"owner\" ON \"public\".\"notes\" AS PERMISSIVE FOR ALL TO \"authenticated\" \
              USING (owner = auth.uid()) WITH CHECK (owner = auth.uid())"
            ]
        );
    }

    #[test]
    fn roles_restrictive_and_public() {
        let mut policy = def(Command::Select, Some("true"), None);
        policy.permissive = false;
        policy.roles = vec![
            PolicyRole::Anon,
            PolicyRole::Authenticated,
            PolicyRole::Anon,
        ];
        assert!(
            create("public", "t", &policy).unwrap()[0]
                .contains("AS RESTRICTIVE FOR SELECT TO \"anon\", \"authenticated\" USING (true)")
        );
        policy.roles = vec![];
        assert!(create("public", "t", &policy).unwrap()[0].contains(" TO PUBLIC "));
        policy.roles = vec![PolicyRole::Anon, PolicyRole::Public];
        assert!(create("public", "t", &policy).unwrap()[0].contains(" TO PUBLIC "));
    }

    #[test]
    fn expressions_follow_the_command() {
        assert!(create("public", "t", &def(Command::Insert, None, Some("true"))).is_ok());
        assert!(
            create(
                "public",
                "t",
                &def(Command::Insert, Some("true"), Some("true"))
            )
            .is_err()
        );
        assert!(create("public", "t", &def(Command::Insert, None, None)).is_err());
        let err = create(
            "public",
            "t",
            &def(Command::Select, Some("true"), Some("true")),
        )
        .unwrap_err();
        assert_eq!(err.code, "policy_check_not_allowed");
        assert_eq!(err.params, json!({ "command": "SELECT" }));
        assert!(create("public", "t", &def(Command::Delete, None, None)).is_err());
        assert!(create("public", "t", &def(Command::Update, Some("true"), None)).is_ok());
        assert!(create("public", "t", &def(Command::Select, Some("   "), None)).is_err());
    }

    #[test]
    fn edit_is_drop_and_recreate() {
        let policy = PolicyDef {
            name: "new name".into(),
            ..def(Command::Select, Some("true"), None)
        };
        let sql = replace("public", "t", "old", &policy).unwrap();
        assert_eq!(sql[0], "DROP POLICY \"old\" ON \"public\".\"t\"");
        assert!(sql[1].starts_with("CREATE POLICY \"new name\" ON \"public\".\"t\""));
    }

    #[test]
    fn guided_access_enables_protection_and_only_adds_needed_grants() {
        let mut policy = def(Command::Select, Some("true"), None);
        policy.roles = vec![
            PolicyRole::Anon,
            PolicyRole::Authenticated,
            PolicyRole::Anon,
        ];
        let sql = prepare_access("public", "notes", &policy);
        assert_eq!(sql.len(), 3);
        assert_eq!(
            sql[0],
            "ALTER TABLE \"public\".\"notes\" ENABLE ROW LEVEL SECURITY"
        );
        assert!(sql[1].contains("GRANT SELECT ON TABLE"));
        assert!(sql[2].contains("TO \"authenticated\""));
        assert!(
            !sql.iter()
                .any(|statement| statement.contains("REVOKE") || statement.contains("INSERT"))
        );
        policy.command = Command::All;
        policy.roles = vec![PolicyRole::Authenticated];
        let sql = prepare_access("public", "notes", &policy);
        assert_eq!(sql.len(), 2);
        assert!(sql[1].contains("GRANT SELECT, INSERT, UPDATE, DELETE"));
    }
}
