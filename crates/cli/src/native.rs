//! Hosts without Docker (`nelcota init --runtime systemd`): one project per
//! machine, on Debian or Ubuntu. Postgres 17 and pgBackRest come from the
//! PostgreSQL project's apt repository (PGDG), Caddy from its own, and the
//! app is a hardened systemd unit running a copy of this binary.
//!
//! ```text
//! /usr/local/lib/nelcota/nelcota            the binary the unit runs (nelcota.previous: rollback)
//! /etc/systemd/system/nelcota-<name>.service
//! /etc/postgresql/17/main/conf.d/nelcota.conf   the Postgres profile
//! /etc/caddy/Caddyfile                      generated from nelcota-host.json
//! /etc/pgbackrest/pgbackrest.conf           with PITR on
//! ```

mod binary;
mod postgres;
mod provisioning;
mod units;
pub(crate) use units::render_unit;

pub use binary::{deploy_binary, deployed_binary, rollback_binary};
pub(crate) use postgres::postgres_command;
pub use postgres::{PG_DATA, POSTGRES_UNIT, configure_postgres};
pub use provisioning::{check_machine, install_packages};
pub use units::{app_unit, install_unit, systemctl, systemctl_quiet, unit_path, unit_state};

pub const APP_LISTEN: &str = "127.0.0.1:8000";
pub const PGBACKREST_CONF: &str = "/etc/pgbackrest/pgbackrest.conf";

/// Removing a native project tears down its unit before its database cluster.
pub fn remove(project: &crate::project::Project) -> anyhow::Result<()> {
    units::remove_unit(project)?;
    postgres::remove_cluster()?;
    let _ = std::fs::remove_file(PGBACKREST_CONF);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{postgres::render_postgres_conf, units::render_unit};
    use std::path::Path;

    #[test]
    fn the_unit_runs_the_deployed_binary_locked_down() {
        let unit = render_unit("shop", Path::new("/opt/nelcota/projects/shop/.env"));
        for line in [
            "ExecStart=/usr/local/lib/nelcota/nelcota serve",
            "EnvironmentFile=/opt/nelcota/projects/shop/.env",
            "Environment=NELCOTA_LISTEN=127.0.0.1:8000",
            "Environment=NELCOTA_PROJECT_NAME=shop",
            "Requires=postgresql@17-main.service",
            "DynamicUser=yes",
            "StateDirectory=nelcota-shop",
            "ProtectSystem=strict",
            "WantedBy=multi-user.target",
        ] {
            assert!(unit.lines().any(|l| l == line), "{line} missing:\n{unit}");
        }
    }

    #[test]
    fn the_profile_becomes_a_conf_d_file() {
        let conf = render_postgres_conf("1gb");
        assert!(conf.contains("shared_buffers = '128MB'\n"), "{conf}");
        assert!(conf.contains("shared_preload_libraries = 'pg_stat_statements'\n"));
        let comments = conf.lines().filter(|l| l.starts_with('#')).count();
        assert_eq!(comments, 1, "only the header is a comment:\n{conf}");
    }
}
