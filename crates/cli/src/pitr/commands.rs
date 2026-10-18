//! pgBackRest and PostgreSQL process adapters for both project runtimes.
use crate::project::{Project, run};
const STANZA: &str = "--stanza=main";

/// `pgbackrest --stanza=main <args>` as the postgres user.
pub(super) fn pgbackrest(project: &Project, args: &[&str]) -> anyhow::Result<()> {
    let mut full = vec!["pgbackrest", STANZA];
    full.extend_from_slice(args);
    run(
        &mut project.as_postgres(&full),
        &format!("pgbackrest {}", args.join(" ")),
    )
}

/// Statements outside a transaction (ALTER SYSTEM cannot run in one).
pub(super) fn psql(project: &Project, statements: &[&str]) -> anyhow::Result<()> {
    let mut args = vec!["psql", "-v", "ON_ERROR_STOP=1", "-q"];
    for statement in statements {
        args.extend(["-c", statement]);
    }
    run(&mut project.as_postgres(&args), "psql")
}

fn restore_args(time: Option<&str>) -> Vec<String> {
    let mut args = vec!["pgbackrest".into(), STANZA.into(), "--delta".into()];
    if let Some(time) = time {
        args.extend([
            "--type=time".into(),
            format!("--target={time}"),
            "--target-action=promote".into(),
        ]);
    }
    args.push("restore".into());
    args
}
pub(super) fn restore(project: &Project, time: Option<&str>) -> anyhow::Result<()> {
    let args = restore_args(time);
    let args: Vec<_> = args.iter().map(String::as_str).collect();
    run(
        &mut project.as_postgres_offline(&args),
        "pgbackrest restore",
    )
}

#[cfg(test)]
mod tests {
    use super::restore_args;
    #[test]
    fn time_target_is_one_argument_and_promotes_the_restored_timeline() {
        assert_eq!(
            restore_args(Some("2026-10-08 10:20:30+00")),
            vec![
                "pgbackrest",
                "--stanza=main",
                "--delta",
                "--type=time",
                "--target=2026-10-08 10:20:30+00",
                "--target-action=promote",
                "restore"
            ]
        );
        assert_eq!(
            restore_args(None),
            vec!["pgbackrest", "--stanza=main", "--delta", "restore"]
        );
    }
}
