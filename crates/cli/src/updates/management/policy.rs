//! Provisioning policy and enrolled project identity shared by host operations.
use crate::{
    host::{Host, Runtime},
    project::Project,
    updates::policy::{Policy, Provisioning, trusted_path},
};
use anyhow::bail;
use nelcota_deployment::read_private;
use std::{fs, path::Path};

pub(in crate::updates) fn validate_policy(p: &Provisioning) -> anyhow::Result<()> {
    let version = semver::Version::parse(&p.version)?;
    if !version.pre.is_empty()
        || !version.build.is_empty()
        || !nelcota_deployment::valid_digest(&p.image_digest)
        || p.source_sha.len() != 40
        || !p
            .source_sha
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || p.max_projects == 0
        || p.max_projects > 32
        || p.domain_suffixes.is_empty()
        || p.domain_suffixes.len() > 16
        || p.domain_suffixes
            .iter()
            .any(|s| !crate::naming::is_valid_domain(s) || s != &s.to_ascii_lowercase())
        || p.service_hosts.len() > 32
        || p.service_hosts
            .iter()
            .any(|s| !crate::naming::is_valid_domain(s) || s != &s.to_ascii_lowercase())
        || p.addresses.is_empty()
        || p.addresses.len() > 8
        || p.addresses.iter().any(|s| {
            s.parse::<std::net::IpAddr>()
                .map_or(true, |ip| !public_ip(ip))
        })
    {
        bail!("invalid host management policy");
    }
    Ok(())
}
/// Sanity check for the operator's own VPS addresses in the root-owned
/// provisioning policy. These are expected DNS answers for managed domains, not
/// user-supplied egress destinations, so this stays looser than the SSRF guard
/// `nelcota_core::net::is_public_address` (CGNAT and documentation addresses
/// keep loading, so installed policies don't break). It still refuses reserved
/// IPv4 and IPv6 forms that embed an IPv4 address, because health checks and
/// probes connect to these addresses.
pub(super) fn public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(ip) => {
            !ip.is_private()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_unspecified()
                && !ip.is_multicast()
                && !ip.is_broadcast()
                && ip.octets()[0] != 0
                && ip.octets()[0] < IPV4_RESERVED_FIRST_OCTET
        }
        std::net::IpAddr::V6(ip) => {
            ip.to_ipv4_mapped().is_none()
                && !embeds_ipv4(ip.segments())
                && !ip.is_loopback()
                && !ip.is_unspecified()
                && !ip.is_multicast()
                && !ip.is_unique_local()
                && !ip.is_unicast_link_local()
        }
    }
}
/// 240.0.0.0/4 is reserved and never routed.
const IPV4_RESERVED_FIRST_OCTET: u8 = 240;
/// NAT64 64:ff9b::/96 and the local-use 64:ff9b:1::/48.
const NAT64_FIRST_SEGMENT: u16 = 0x0064;
const NAT64_SECOND_SEGMENT: u16 = 0xff9b;
const NAT64_LOCAL_SECOND_SEGMENT: u16 = 0xff9b;
const NAT64_LOCAL_THIRD_SEGMENT: u16 = 0x0001;
/// 6to4 2002::/16 and Teredo 2001::/32.
const SIX_TO_FOUR_FIRST_SEGMENT: u16 = 0x2002;
const TEREDO_FIRST_SEGMENT: u16 = 0x2001;
const TEREDO_SECOND_SEGMENT: u16 = 0x0000;
/// IPv6 forms that carry an IPv4 address a router may translate to.
pub(super) fn embeds_ipv4(segments: [u16; 8]) -> bool {
    let [first, second, third, ..] = segments;
    // IPv4-compatible ::/96 (::1 and :: are covered by the loopback/unspecified checks).
    let compatible = segments[..6].iter().all(|segment| *segment == 0);
    let nat64 = first == NAT64_FIRST_SEGMENT
        && second == NAT64_SECOND_SEGMENT
        && segments[2..6].iter().all(|segment| *segment == 0);
    let nat64_local = first == NAT64_FIRST_SEGMENT
        && second == NAT64_LOCAL_SECOND_SEGMENT
        && third == NAT64_LOCAL_THIRD_SEGMENT;
    let six_to_four = first == SIX_TO_FOUR_FIRST_SEGMENT;
    let teredo = first == TEREDO_FIRST_SEGMENT && second == TEREDO_SECOND_SEGMENT;
    compatible || nat64 || nat64_local || six_to_four || teredo
}
/// Zero when unmeasurable, so disk blockers fail closed.
pub(in crate::updates) fn free_bytes(root: &Path) -> u64 {
    crate::checks::free_bytes(root).unwrap_or(0)
}
pub(in crate::updates) fn control_project(policy: &Policy, name: &str) -> anyhow::Result<Project> {
    if !nelcota_deployment::valid_project(name) || !policy.project_enrolled(name) {
        bail!("project identity changed");
    }
    let host = Host::new(&policy.root);
    let manifest = host.require()?;
    let project = host.select(&manifest, Some(name))?;
    trusted_path(&project.path(".env"))?;
    read_private(&project.path(".env"), 65536)?;
    trusted_path(&project.path("docker-compose.yml"))?;
    let text = fs::read_to_string(project.path("docker-compose.yml"))?;
    if project.runtime != Runtime::Docker
        || !crate::updates::enroll::known_project_compose(&project, &text)
    {
        bail!("custom project layout is not managed");
    }
    if project.env().get("NELCOTA_STORAGE_BACKEND")?.as_deref() != Some("disk")
        || project.path("pgbackrest.env").exists()
    {
        bail!("S3 storage and PITR need their separate recovery workflow");
    }
    Ok(project)
}
