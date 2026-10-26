//! Outbound address policy shared by every server-side request to a
//! user-supplied destination (project webhooks, host alert webhooks).

use std::net::IpAddr;

/// Conservative public-unicast check used as an SSRF guard.
///
/// IPv4 rejects this-network, private, loopback, link-local, CGNAT, IETF
/// protocol assignments, the 6to4 relay anycast, benchmarking, documentation,
/// multicast, reserved and broadcast ranges. IPv6 is an allowlist of global
/// unicast 2000::/3 minus 2001::/23 (Teredo, benchmarking, ORCHID and other
/// IETF assignments), documentation 2001:db8::/32 and 3fff::/20, and 6to4
/// 2002::/16. Everything outside 2000::/3 is refused, which covers loopback,
/// IPv4-mapped/compatible, NAT64, discard-only 100::/64, unique-local,
/// link-local and multicast addresses.
pub fn is_public_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(matches!(a, 0 | 10 | 127)
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192
                    && (b == 168 || (b == 0 && (c == 0 || c == 2)) || (b == 88 && c == 99)))
                || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            let s = ip.segments();
            (s[0] & 0xe000) == 0x2000
                && !(s[0] == 0x2001 && (s[1] < 0x200 || s[1] == 0xdb8))
                && s[0] != 0x2002
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::is_public_address;

    fn assert_rejected(addresses: &[&str]) {
        for ip in addresses {
            assert!(!is_public_address(ip.parse().unwrap()), "accepted: {ip}");
        }
    }

    fn assert_accepted(addresses: &[&str]) {
        for ip in addresses {
            assert!(is_public_address(ip.parse().unwrap()), "rejected: {ip}");
        }
    }

    #[test]
    fn rejects_private_loopback_and_link_local_ipv4() {
        assert_rejected(&[
            "0.0.0.0",
            "0.1.2.3",
            "10.0.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.0.1",
            "224.0.0.1",
            "240.0.0.1",
            "255.255.255.255",
        ]);
        assert_accepted(&["1.1.1.1", "8.8.8.8", "172.15.255.255", "172.32.0.0"]);
    }

    #[test]
    fn rejects_shared_reserved_and_documentation_ipv4() {
        assert_rejected(&[
            // CGNAT 100.64.0.0/10
            "100.64.0.0",
            "100.100.100.200",
            "100.127.255.255",
            // IETF protocol assignments 192.0.0.0/24
            "192.0.0.1",
            // TEST-NET-1/2/3
            "192.0.2.1",
            "198.51.100.1",
            "203.0.113.1",
            // 6to4 relay anycast 192.88.99.0/24
            "192.88.99.1",
            // Benchmarking 198.18.0.0/15
            "198.18.0.1",
            "198.19.255.255",
        ]);
        assert_accepted(&[
            "100.63.255.255",
            "100.128.0.0",
            "192.0.1.255",
            "192.88.98.255",
            "198.17.255.255",
            "198.20.0.0",
        ]);
    }

    #[test]
    fn rejects_ipv4_mapped_compatible_and_translated_ipv6() {
        assert_rejected(&[
            "::ffff:8.8.8.8",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::a00:1",
            "64:ff9b::a00:1",
            "64:ff9b:1::1",
            "2001::1",
            "2002:a00:1::1",
        ]);
    }

    #[test]
    fn rejects_non_global_ipv6() {
        assert_rejected(&[
            "::",
            "::1",
            // Discard-only 100::/64
            "100::1",
            // Benchmarking 2001:2::/48 and the rest of 2001::/23
            "2001:2::1",
            "2001:1ff::1",
            // Documentation 2001:db8::/32 and 3fff::/20
            "2001:db8::1",
            "3fff::1",
            "3fff:fff::1",
            "fc00::1",
            "fd00::1",
            "fe80::1",
            "ff02::1",
            "4000::1",
        ]);
        assert_accepted(&[
            "2001:200::1",
            "2001:4860:4860::8888",
            "2606:4700:4700::1111",
            "3fff:1000::1",
        ]);
    }
}
