//! In-memory rate limit per key (IP, email): `limit` requests per minute.
//!
//! Uses governor's GCRA: the budget refills continuously (one request every
//! `60 / limit` seconds) instead of resetting at the turn of a fixed minute,
//! which let a client spend almost twice the limit across the boundary.
//! Still in memory: a single binary per install needs no Redis (D26).
//!
//! Keys live in bounded stores. Network keys (an IP or an IPv6 /64) cost an
//! attacker one address each. Account keys contain an email, so they are kept
//! apart, and only existing accounts get one. Emails without an account get a
//! decoy budget in a store of their own, so a flood of made-up emails can fill
//! neither the network store nor the account store. No store ever drops a
//! recent key: a decoy store that evicted when full would let a flood reset a
//! made-up email's budget early, which a real account never allows, and so
//! tell the two apart.
//!
//! A single IPv6 /48 holds 65,536 /64s, enough to fill the network store on
//! its own. So the network keys of one /48 may take at most
//! `1 / BLOCK_SHARE` of the store: past that, new /64s of that /48 are treated
//! as if the store were full, while every other network keeps working.
//!
//! Password attempts also have an account-wide budget, `ACCOUNT_BUDGET_FACTOR`
//! times the per-IP one, so many addresses cannot guess one account's password
//! much faster than one address could, while one address alone cannot use it
//! up. Over that budget the caller decides (see `password_grant`): networks
//! where the account has open sessions get through after a growing delay,
//! drawing from a second budget of the same size, so many addresses inside a
//! known network cannot guess without limit either.

use crate::AuthState;
use nelcota_core::ApiError;

use std::{
    collections::HashMap,
    num::NonZeroU32,
    sync::{
        RwLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use governor::{
    Quota,
    clock::{Clock, DefaultClock, Reference},
    middleware::NoOpMiddleware,
    state::{InMemoryState, NotKeyed},
};

/// Refreshes and PKCE redemptions get this many times the per-IP budget of
/// password sign-in (`NELCOTA_AUTH_RATE_LIMIT_PER_MINUTE`).
pub const SESSION_RATE_LIMIT_FACTOR: u32 = 10;

/// Capacity of each store, enforced without evicting a key's active limit.
const MAX_KEYS: usize = 50_000;
/// One IPv6 /48 may hold at most this fraction of the network store's keys
/// (781 of 50,000).
const BLOCK_SHARE: usize = 64;
const CLEANUP_INTERVAL: Duration = Duration::from_secs(1);
const FULL_REFILL: Duration = Duration::from_secs(60);
const LOGIN_DELAY_BASE: Duration = Duration::from_millis(125);
const LOGIN_DELAY_MAX_STEP: u64 = 4;
/// The account-wide password budget is this many times the per-IP one.
const ACCOUNT_BUDGET_FACTOR: u32 = 10;
const ACCOUNT_FACTOR: NonZeroU32 = NonZeroU32::new(ACCOUNT_BUDGET_FACTOR).unwrap();

type Direct<C> =
    governor::RateLimiter<NotKeyed, InMemoryState, C, NoOpMiddleware<<C as Clock>::Instant>>;

struct Entry<C: Clock> {
    limiter: Direct<C>,
    last_accepted: AtomicU64,
    login_delay_step: AtomicU64,
}

struct State<C: Clock> {
    entries: HashMap<String, Entry<C>>,
    /// Keys per IPv6 /48, in a store whose blocks are capped.
    blocks: HashMap<String, usize>,
    last_cleanup: C::Instant,
    #[cfg(test)]
    cleanups: usize,
}

/// One bounded key store, whose keys share one quota.
struct Store<C: Clock> {
    state: RwLock<State<C>>,
    quota: Quota,
    capacity: usize,
    /// How many keys one IPv6 /48 may hold, when its keys are network keys.
    block_capacity: Option<usize>,
    name: &'static str,
}

impl<C: Clock> Store<C> {
    fn new(name: &'static str, quota: Quota, capacity: usize, start: C::Instant) -> Self {
        Store {
            state: RwLock::new(State {
                entries: HashMap::new(),
                blocks: HashMap::new(),
                last_cleanup: start,
                #[cfg(test)]
                cleanups: 0,
            }),
            quota,
            capacity,
            block_capacity: None,
            name,
        }
    }

    /// Caps the keys of each IPv6 /48 (see `ipv6_block`).
    fn with_block_cap(mut self) -> Self {
        self.block_capacity = Some((self.capacity / BLOCK_SHARE).max(1));
        self
    }
}

/// The IPv6 /48 (`a:b:c`) of a network key that ends in an `ip_key` /64
/// (`<endpoint>:a:b:c:d::/64`); `None` for IPv4 and non-network keys.
fn ipv6_block(key: &str) -> Option<&str> {
    let body = key.strip_suffix("::/64")?;
    let mut segments = body.rsplitn(5, ':');
    let d = segments.next()?;
    let c = segments.next()?;
    let b = segments.next()?;
    let a = segments.next()?;
    let hex = |s: &str| (1..=4).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_hexdigit());
    if ![a, b, c, d].into_iter().all(hex) {
        return None;
    }
    let start = body.len() - d.len() - 1 - c.len() - 1 - b.len() - 1 - a.len();
    Some(&body[start..body.len() - d.len() - 1])
}

enum Admission {
    Accepted,
    Limited(Duration),
    /// The store is full and the key is not tracked yet.
    Full,
}

/// Generic over the clock only so tests can drive time by hand.
pub struct RateLimiter<C: Clock + Clone = DefaultClock> {
    network: Store<C>,
    accounts: Store<C>,
    /// One signup notice per existing account and minute.
    notices: Store<C>,
    /// Account-sized budgets for emails without an account, one per email.
    /// Full like `accounts`: an untracked email passes on its per-IP budget.
    /// The two are paired: neither tracks a new key while the other is full.
    decoys: Store<C>,
    clock: C,
    start: C::Instant,
}

impl RateLimiter {
    pub fn new(limit_per_minute: u32) -> Self {
        Self::with_clock(limit_per_minute, DefaultClock::default())
    }
}

impl<C: Clock + Clone> RateLimiter<C> {
    fn with_clock(limit_per_minute: u32, clock: C) -> Self {
        Self::with_capacity(limit_per_minute, clock, MAX_KEYS)
    }

    fn with_capacity(limit_per_minute: u32, clock: C, capacity: usize) -> Self {
        let limit = NonZeroU32::new(limit_per_minute).unwrap_or(NonZeroU32::MIN);
        let network = Quota::per_minute(limit);
        let accounts = Quota::per_minute(limit.saturating_mul(ACCOUNT_FACTOR));
        let start = clock.now();
        RateLimiter {
            network: Store::new("network", network, capacity, start).with_block_cap(),
            accounts: Store::new("account", accounts, capacity, start),
            notices: Store::new(
                "notice",
                Quota::with_period(FULL_REFILL).expect("non-zero period"),
                capacity,
                start,
            ),
            decoys: Store::new("decoy", accounts, capacity, start),
            clock,
            start,
        }
    }

    fn check_entry(&self, entry: &Entry<C>) -> Result<(), Duration> {
        entry
            .limiter
            .check()
            .map_err(|not_until| not_until.wait_time_from(self.clock.now()))?;
        entry.last_accepted.fetch_max(
            self.clock.now().duration_since(self.start).as_u64(),
            Ordering::Relaxed,
        );
        Ok(())
    }

    fn outcome(&self, entry: &Entry<C>) -> Admission {
        match self.check_entry(entry) {
            Ok(()) => Admission::Accepted,
            Err(wait) => Admission::Limited(wait),
        }
    }

    fn admit(&self, store: &Store<C>, key: &str) -> Admission {
        self.admit_paired(store, key, None)
    }

    /// Like [`admit`](Self::admit), but a new key is also left untracked while
    /// `peer` is full. Accounts and decoys are paired this way: whichever store
    /// a flood fills, a new real email and a new made-up one get the same
    /// answer, so the fill cannot tell them apart.
    fn admit_paired(&self, store: &Store<C>, key: &str, peer: Option<&Store<C>>) -> Admission {
        {
            let state = store.state.read().unwrap_or_else(|e| e.into_inner());
            if let Some(entry) = state.entries.get(key) {
                return self.outcome(entry);
            }
        }
        // Before taking this store's write lock, so two stores never wait on
        // each other.
        if peer.is_some_and(|peer| self.full(peer)) {
            return Admission::Full;
        }

        // Serialize new-key admission only. Existing keys share a read lock
        // and governor still atomically enforces each independent GCRA budget.
        let mut state = store.state.write().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = state.entries.get(key) {
            return self.outcome(entry);
        }
        let now = self.clock.now();
        let block = store.block_capacity.and(ipv6_block(key));
        let block_full = |state: &State<C>| match (block, store.block_capacity) {
            (Some(block), Some(cap)) => state.blocks.get(block).is_some_and(|n| *n >= cap),
            _ => false,
        };
        // At most once per second per store, so these cannot flood logs.
        if (state.entries.len() >= store.capacity || block_full(&state))
            && self.sweep(store, &mut state, now)
        {
            if state.entries.len() >= store.capacity {
                tracing::warn!(
                    store = store.name,
                    capacity = store.capacity,
                    "rate limit key store is full"
                );
            }
            if block_full(&state) {
                tracing::warn!(
                    store = store.name,
                    block_capacity = store.block_capacity,
                    "one IPv6 /48 holds its whole share of the rate limit key store"
                );
            }
        }
        // Never drop a recent entry to make room: its next attempt would
        // obtain a fresh burst and bypass the quota. A /48 at its share is
        // treated like a full store, for its own new keys only.
        if state.entries.len() >= store.capacity || block_full(&state) {
            return Admission::Full;
        }
        if let Some(block) = block {
            *state.blocks.entry(block.to_owned()).or_insert(0) += 1;
        }
        let entry = state
            .entries
            .entry(key.to_owned())
            .or_insert_with(|| Entry {
                limiter: governor::RateLimiter::direct_with_clock(store.quota, self.clock.clone()),
                last_accepted: AtomicU64::new(now.duration_since(self.start).as_u64()),
                login_delay_step: AtomicU64::new(0),
            });
        self.outcome(entry)
    }

    /// Whether `store` is full once its fully refilled keys are dropped.
    fn full(&self, store: &Store<C>) -> bool {
        {
            let state = store.state.read().unwrap_or_else(|e| e.into_inner());
            if state.entries.len() < store.capacity {
                return false;
            }
        }
        let mut state = store.state.write().unwrap_or_else(|e| e.into_inner());
        self.sweep(store, &mut state, self.clock.now());
        state.entries.len() >= store.capacity
    }

    /// Drops the keys whose budget has fully refilled, at most once per
    /// [`CLEANUP_INTERVAL`]. Returns whether it ran.
    fn sweep(&self, store: &Store<C>, state: &mut State<C>, now: C::Instant) -> bool {
        if now.duration_since(state.last_cleanup) < CLEANUP_INTERVAL.into() {
            return false;
        }
        let elapsed = now.duration_since(self.start).as_u64();
        state.entries.retain(|_, entry| {
            elapsed.saturating_sub(entry.last_accepted.load(Ordering::Relaxed))
                < FULL_REFILL.as_nanos() as u64
        });
        if store.block_capacity.is_some() {
            let mut blocks = HashMap::new();
            for key in state.entries.keys() {
                if let Some(block) = ipv6_block(key) {
                    *blocks.entry(block.to_owned()).or_insert(0) += 1;
                }
            }
            state.blocks = blocks;
        }
        state.last_cleanup = now;
        #[cfg(test)]
        {
            state.cleanups += 1;
        }
        true
    }

    /// `Ok` while the key has budget; `Err(wait)` until its budget refills.
    /// For network keys (an IP from `ip_key`, optionally with a prefix).
    /// Unknown keys are refused while the store is full, with a retry hint.
    /// Each network holds a handful of keys (one per endpoint), so filling
    /// the store takes thousands of distinct networks (IPv4 addresses or IPv6
    /// /64s) kept busy every minute. One IPv6 /48 can take only its share of
    /// the store: past it, its own new /64s are refused, nobody else's.
    pub fn check(&self, key: &str) -> Result<(), Duration> {
        match self.admit(&self.network, key) {
            Admission::Accepted => Ok(()),
            Admission::Limited(wait) => Err(wait),
            Admission::Full => Err(CLEANUP_INTERVAL),
        }
    }

    /// Like `check`, but an unknown key passes untracked while the store is
    /// full. For abuse budgets whose refusal would hurt more than an
    /// occasional untracked request, such as the REST and storage APIs.
    pub fn check_lenient(&self, key: &str) -> Result<(), Duration> {
        match self.admit(&self.network, key) {
            Admission::Accepted | Admission::Full => Ok(()),
            Admission::Limited(wait) => Err(wait),
        }
    }

    /// The account-wide budget of password attempts: `None` while it lasts,
    /// `Some(wait)` once it is spent. Only existing accounts are charged, so
    /// filling the store takes that many real accounts; while it is full an
    /// account it does not track passes untracked (a warning is logged), still
    /// bounded by its caller's per-IP budget, rather than refusing every new
    /// network for everyone. The caller admits a spent budget only for
    /// networks the account knows, after `login_delay`.
    pub(crate) fn login_budget(&self, account: &str) -> Option<Duration> {
        let key = format!("login:{account}");
        match self.admit_paired(&self.accounts, &key, Some(&self.decoys)) {
            Admission::Accepted => {
                self.reset_login_delay(&key);
                None
            }
            Admission::Limited(wait) => Some(wait),
            Admission::Full => None,
        }
    }

    /// The account-wide budget for an email without an account: a budget of
    /// its own, the same size, so it runs out and refills exactly as an
    /// account's would and spending it says nothing about other emails. These
    /// live in a separate store, so made-up emails never crowd out real
    /// accounts. That store fills exactly like the account store: a tracked
    /// decoy keeps its budget until it has fully refilled, and while the store
    /// is full an untracked email passes untracked, bounded by its caller's
    /// per-IP budget, the same path an untracked account takes. A flood of
    /// made-up emails therefore never resets a decoy early, which would tell
    /// made-up emails from real ones.
    pub(crate) fn decoy_login_budget(&self, email: &str) -> Option<Duration> {
        match self.admit_paired(&self.decoys, email, Some(&self.accounts)) {
            Admission::Accepted | Admission::Full => None,
            Admission::Limited(wait) => Some(wait),
        }
    }

    /// Whether the owner of `email`, an existing account, may get a signup
    /// notice now: one per minute, like the email links. While the store is
    /// full, no notice goes out.
    pub(crate) fn signup_notice(&self, email: &str) -> bool {
        matches!(self.admit(&self.notices, email), Admission::Accepted)
    }

    /// The account's second budget, the same size, for attempts from known
    /// networks once `login_budget` is spent: `None` while it lasts. The
    /// owner never comes close to both, while attackers with many addresses
    /// inside a known network (a shared /24, a hosting range) still hit a
    /// ceiling. Untracked while the store is full, like `login_budget`.
    pub(crate) fn known_network_budget(&self, account: &str) -> Option<Duration> {
        match self.admit(&self.accounts, &format!("login-known:{account}")) {
            Admission::Accepted | Admission::Full => None,
            Admission::Limited(wait) => Some(wait),
        }
    }

    /// The growing delay (up to two seconds) of an attempt admitted over the
    /// account budget.
    pub(crate) fn login_delay(&self, account: &str) -> Duration {
        self.next_login_delay(&format!("login:{account}"))
    }

    fn reset_login_delay(&self, key: &str) {
        let state = self
            .accounts
            .state
            .read()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = state.entries.get(key) {
            entry.login_delay_step.store(0, Ordering::Relaxed);
        }
    }

    fn next_login_delay(&self, key: &str) -> Duration {
        let state = self
            .accounts
            .state
            .read()
            .unwrap_or_else(|e| e.into_inner());
        // A cleanup may have dropped an idle entry in between: nothing to delay.
        let entry = match state.entries.get(key) {
            Some(entry) => entry,
            None => return Duration::ZERO,
        };
        let step = entry
            .login_delay_step
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |step| {
                Some(step.saturating_add(1).min(LOGIN_DELAY_MAX_STEP))
            })
            .expect("delay update always supplies a value");
        LOGIN_DELAY_BASE * (1_u32 << step.min(LOGIN_DELAY_MAX_STEP))
    }
}

/// Whole seconds for `Retry-After`, rounded up so a client never retries
/// before its budget has refilled.
pub fn retry_after_secs(wait: Duration) -> u64 {
    wait.as_secs() + u64::from(wait.subsec_nanos() > 0)
}

pub(crate) fn limit(state: &AuthState, key: &str) -> Result<(), ApiError> {
    state
        .limiter
        .check(key)
        .map_err(|wait| ApiError::rate_limited(retry_after_secs(wait)))
}

/// The budget of refreshes and PKCE redemptions (`session_limiter`).
pub(crate) fn limit_sessions(state: &AuthState, key: &str) -> Result<(), ApiError> {
    state
        .session_limiter
        .check(key)
        .map_err(|wait| ApiError::rate_limited(retry_after_secs(wait)))
}

#[cfg(test)]
mod tests {
    use governor::clock::FakeRelativeClock;

    use super::*;

    fn limiter(limit: u32) -> (RateLimiter<FakeRelativeClock>, FakeRelativeClock) {
        let clock = FakeRelativeClock::default();
        (RateLimiter::with_clock(limit, clock.clone()), clock)
    }

    fn len(store: &Store<FakeRelativeClock>) -> usize {
        store.state.read().unwrap().entries.len()
    }

    fn cleanups(store: &Store<FakeRelativeClock>) -> usize {
        store.state.read().unwrap().cleanups
    }

    #[test]
    fn blocks_above_the_limit_and_keys_are_independent() {
        let (limiter, _) = limiter(2);
        assert!(limiter.check("ip").is_ok());
        assert!(limiter.check("ip").is_ok());
        let wait = limiter.check("ip").unwrap_err();
        // 2 per minute: one more request is allowed 30 s later.
        assert_eq!(wait, Duration::from_secs(30));
        assert!(limiter.check("other-ip").is_ok());
    }

    #[test]
    fn budget_refills_gradually() {
        let (limiter, clock) = limiter(2);
        assert!(limiter.check("ip").is_ok());
        assert!(limiter.check("ip").is_ok());
        clock.advance(Duration::from_secs(30));
        assert!(limiter.check("ip").is_ok());
        assert!(limiter.check("ip").is_err());
        clock.advance(Duration::from_secs(60));
        assert!(limiter.check("ip").is_ok());
        assert!(limiter.check("ip").is_ok());
        assert!(limiter.check("ip").is_err());
    }

    #[test]
    fn no_double_budget_across_a_minute_boundary() {
        // The old fixed window allowed `limit` at 0:59 and `limit` again at 1:00.
        let (limiter, clock) = limiter(10);
        clock.advance(Duration::from_secs(59));
        for _ in 0..10 {
            assert!(limiter.check("ip").is_ok());
        }
        clock.advance(Duration::from_secs(1));
        assert!(
            limiter.check("ip").is_err(),
            "only 1 s of refill, not a fresh minute"
        );
    }

    #[test]
    fn zero_limit_still_allows_one_per_minute() {
        let (limiter, _) = limiter(0);
        assert!(limiter.check("ip").is_ok());
        assert!(limiter.check("ip").is_err());
    }

    #[test]
    fn high_cardinality_is_bounded_without_resetting_existing_budget() {
        let (limiter, _) = limiter(1);
        for i in 0..MAX_KEYS {
            assert!(limiter.check(&format!("key:{i}")).is_ok());
        }
        for i in 0..300 {
            assert!(
                limiter.check(&format!("new:{i}")).is_err(),
                "capacity is full"
            );
        }
        assert_eq!(limiter.check("key:0"), Err(Duration::from_secs(60)));
        assert_eq!(len(&limiter.network), MAX_KEYS);
        assert_eq!(
            cleanups(&limiter.network),
            0,
            "a frozen clock must not trigger repeated scans"
        );
    }

    #[test]
    fn cleanup_is_amortized_and_only_drops_fully_refilled_keys() {
        let clock = FakeRelativeClock::default();
        let limiter = RateLimiter::with_capacity(1, clock.clone(), 2);
        assert!(limiter.check("a").is_ok());
        assert!(limiter.check("b").is_ok());
        clock.advance(Duration::from_secs(1));
        for i in 0..100 {
            assert!(limiter.check(&format!("new:{i}")).is_err());
        }
        assert_eq!(cleanups(&limiter.network), 1);
        assert_eq!(limiter.check("a"), Err(Duration::from_secs(59)));
        clock.advance(Duration::from_secs(59));
        assert!(limiter.check("new").is_ok());
        assert_eq!(len(&limiter.network), 1);
        assert_eq!(cleanups(&limiter.network), 2);
        // The evicted key had fully recovered, so its normal budget is valid.
        assert!(limiter.check("a").is_ok());
        assert_eq!(limiter.check("a"), Err(Duration::from_secs(60)));
    }

    #[test]
    fn active_keys_keep_their_budget_during_capacity_pressure() {
        let clock = FakeRelativeClock::default();
        let limiter = RateLimiter::with_capacity(2, clock.clone(), 2);
        assert!(limiter.check("account").is_ok());
        assert!(limiter.check("account").is_ok());
        assert!(limiter.check("ip").is_ok());
        clock.advance(Duration::from_secs(30));
        assert!(limiter.check("account").is_ok());
        assert!(limiter.check("ip").is_ok());
        clock.advance(Duration::from_secs(30));
        assert!(
            limiter.check("new").is_err(),
            "both tracked keys still have state"
        );
        assert!(limiter.check("account").is_ok());
        assert!(
            limiter.check("account").is_err(),
            "cleanup must not restore its full burst"
        );
        assert!(
            limiter.check("ip").is_ok(),
            "other keys retain independent budgets"
        );
    }

    #[test]
    fn concurrent_admission_never_exceeds_capacity() {
        let limiter = std::sync::Arc::new(RateLimiter::with_capacity(
            1,
            FakeRelativeClock::default(),
            8,
        ));
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(32));
        let tasks: Vec<_> = (0..32)
            .map(|i| {
                let limiter = limiter.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    limiter.check(&format!("key:{i}")).is_ok()
                })
            })
            .collect();
        assert_eq!(
            tasks
                .into_iter()
                .map(|task| task.join().unwrap())
                .filter(|accepted| *accepted)
                .count(),
            8
        );
        assert_eq!(len(&limiter.network), 8);
    }

    #[test]
    fn account_budget_is_ten_times_the_ip_budget_and_its_delay_grows() {
        let (limiter, clock) = limiter(2);
        for _ in 0..20 {
            assert_eq!(limiter.login_budget("account"), None);
        }
        assert_eq!(
            limiter.login_budget("account"),
            Some(Duration::from_secs(3)),
            "20 per minute: one more attempt 3 s later"
        );
        for milliseconds in [125, 250, 500, 1_000, 2_000, 2_000] {
            assert_eq!(
                limiter.login_delay("account"),
                Duration::from_millis(milliseconds)
            );
        }
        assert_eq!(limiter.login_budget("other"), None);
        clock.advance(Duration::from_secs(3));
        assert_eq!(limiter.login_budget("account"), None, "refilled");
        assert!(limiter.login_budget("account").is_some());
        assert_eq!(
            limiter.login_delay("account"),
            Duration::from_millis(125),
            "the delay restarts once the budget refilled"
        );
    }

    #[test]
    fn known_networks_have_a_budget_of_their_own() {
        let (limiter, clock) = limiter(1);
        for _ in 0..10 {
            assert_eq!(limiter.login_budget("account"), None);
        }
        assert!(limiter.login_budget("account").is_some(), "spent");
        for _ in 0..10 {
            assert_eq!(limiter.known_network_budget("account"), None);
        }
        assert_eq!(
            limiter.known_network_budget("account"),
            Some(Duration::from_secs(6)),
            "known networks hit a ceiling too"
        );
        assert_eq!(limiter.known_network_budget("other"), None);
        clock.advance(Duration::from_secs(6));
        assert_eq!(limiter.known_network_budget("account"), None, "refilled");
    }

    #[test]
    fn unknown_emails_spend_a_decoy_budget_of_their_own() {
        let (limiter, clock) = limiter(1);
        for _ in 0..10 {
            assert_eq!(limiter.decoy_login_budget("nobody@x"), None);
            assert_eq!(limiter.login_budget("someone@x"), None);
        }
        let decoy = limiter.decoy_login_budget("nobody@x");
        assert_eq!(decoy, limiter.login_budget("someone@x"), "same size");
        assert!(decoy.is_some());
        for i in 0..10_000 {
            assert_eq!(
                limiter.decoy_login_budget(&format!("probe-{i}@x")),
                None,
                "a spent decoy says nothing about other emails"
            );
        }
        assert_eq!(
            len(&limiter.accounts),
            1,
            "decoys stay out of the account store"
        );
        clock.advance(Duration::from_secs(6));
        assert_eq!(limiter.decoy_login_budget("nobody@x"), None, "refilled");
    }

    #[test]
    fn a_full_decoy_store_behaves_exactly_like_the_account_store() {
        // The same flood against made-up emails and real accounts: every
        // answer matches, so the budget cannot tell them apart. A tracked
        // email keeps its spent budget however many others arrive, and new
        // ones pass untracked (on the per-IP budget) until cleanup.
        let run = |budget: &dyn Fn(&RateLimiter<FakeRelativeClock>, &str) -> Option<Duration>| {
            let clock = FakeRelativeClock::default();
            let limiter = RateLimiter::with_capacity(1, clock.clone(), 2);
            let mut answers = Vec::new();
            for _ in 0..10 {
                answers.push(budget(&limiter, "a@x"));
            }
            answers.push(budget(&limiter, "a@x"));
            answers.push(budget(&limiter, "b@x"));
            for i in 0..1000 {
                answers.push(budget(&limiter, &format!("flood-{i}@x")));
            }
            answers.push(budget(&limiter, "a@x"));
            clock.advance(Duration::from_secs(5));
            answers.push(budget(&limiter, "a@x"));
            clock.advance(Duration::from_secs(60));
            answers.push(budget(&limiter, "new@x"));
            answers.push(budget(&limiter, "a@x"));
            (answers, limiter)
        };
        let (decoy, decoys) = run(&|limiter, email| limiter.decoy_login_budget(email));
        let (real, accounts) = run(&|limiter, email| limiter.login_budget(email));
        assert_eq!(decoy, real);
        assert!(decoy[10].is_some(), "a@x is spent");
        assert!(decoy[12..1012].iter().all(Option::is_none), "untracked");
        assert!(decoy[1012].is_some(), "the flood did not reset a@x");
        assert_eq!(len(&decoys.decoys), len(&accounts.accounts));
        assert_eq!(len(&decoys.accounts), 0, "decoys stay out of accounts");
    }

    #[test]
    fn filling_either_email_store_leaves_new_real_and_made_up_emails_alike() {
        let clock = FakeRelativeClock::default();
        let limiter = RateLimiter::with_capacity(1, clock.clone(), 2);
        // A flood of made-up emails fills the decoy store.
        for i in 0..2 {
            assert_eq!(limiter.decoy_login_budget(&format!("flood-{i}@x")), None);
        }
        // A new real account is then as untracked as a new made-up email: both
        // pass on the per-IP budget only, however often they are tried.
        for _ in 0..20 {
            assert_eq!(limiter.login_budget("real@x"), None);
            assert_eq!(limiter.decoy_login_budget("made-up@x"), None);
        }
        assert_eq!(len(&limiter.accounts), 0, "real@x stayed untracked");
        // Once the flood has refilled, both are tracked again.
        clock.advance(Duration::from_secs(60));
        let real: Vec<_> = (0..11).map(|_| limiter.login_budget("real@x")).collect();
        let made_up: Vec<_> = (0..11)
            .map(|_| limiter.decoy_login_budget("made-up@x"))
            .collect();
        assert!(real[10].is_some() && made_up[10].is_some());
    }

    #[test]
    fn account_keys_cannot_fill_the_network_store() {
        let clock = FakeRelativeClock::default();
        let limiter = RateLimiter::with_capacity(1, clock.clone(), 2);
        for i in 0..100 {
            limiter.login_budget(&format!("{i}@x"));
        }
        assert_eq!(len(&limiter.accounts), 2);
        assert_eq!(len(&limiter.network), 0);
        assert!(limiter.check("signup:1.2.3.4").is_ok(), "IPs keep working");
        assert!(limiter.check("token:1.2.3.4").is_ok());
        assert!(
            limiter.check("verify:1.2.3.4").is_err(),
            "network store full"
        );
        assert!(
            limiter.check_lenient("api:1.2.3.4").is_ok(),
            "lenient checks pass untracked while full"
        );
    }

    #[test]
    fn a_full_account_store_keeps_tracked_budgets_and_passes_new_accounts() {
        let clock = FakeRelativeClock::default();
        let limiter = RateLimiter::with_capacity(1, clock.clone(), 2);
        for _ in 0..10 {
            assert_eq!(limiter.login_budget("a"), None);
        }
        assert!(limiter.login_budget("a").is_some(), "a is spent");
        assert_eq!(limiter.login_budget("b"), None);
        assert_eq!(
            limiter.login_budget("new"),
            None,
            "a full store does not refuse every new network"
        );
        assert!(limiter.login_budget("a").is_some(), "a stays spent");
        assert_eq!(len(&limiter.accounts), 2);
        clock.advance(Duration::from_secs(60));
        assert_eq!(limiter.login_budget("new"), None);
        assert_eq!(len(&limiter.accounts), 1, "idle keys were cleaned up");
    }

    #[test]
    fn signup_notices_go_out_once_a_minute_per_account() {
        let (limiter, clock) = limiter(30);
        assert!(limiter.signup_notice("ana@x"));
        assert!(!limiter.signup_notice("ana@x"));
        assert!(limiter.signup_notice("bia@x"), "accounts are independent");
        clock.advance(Duration::from_secs(60));
        assert!(limiter.signup_notice("ana@x"));
    }

    #[test]
    fn ipv6_blocks_come_from_network_keys_only() {
        assert_eq!(ipv6_block("signup:2001:db8:1:2::/64"), Some("2001:db8:1"));
        assert_eq!(ipv6_block("ip:2001:db8:ffff:0::/64"), Some("2001:db8:ffff"));
        assert_eq!(ipv6_block("a:b:c:2001:db8:1:2::/64"), Some("2001:db8:1"));
        assert_eq!(ipv6_block("token:203.0.113.7"), None);
        assert_eq!(ipv6_block("signup:2001:db8:1::/48"), None);
        assert_eq!(ipv6_block("user:5f3c::/64"), None);
        assert_eq!(ipv6_block("x:12345:1:2:3::/64"), None);
    }

    #[test]
    fn one_ipv6_48_cannot_fill_the_network_store() {
        let clock = FakeRelativeClock::default();
        let limiter = RateLimiter::with_capacity(1, clock.clone(), 640);
        let key = |block: u16, net: u16| format!("token:2001:db8:{block:x}:{net:x}::/64");
        // 640 / 64 = 10 keys per /48.
        for net in 0..10 {
            assert!(limiter.check(&key(1, net)).is_ok());
        }
        for net in 10..2_000 {
            assert!(
                limiter.check(&key(1, net)).is_err(),
                "the /48 used its share"
            );
            assert!(
                limiter
                    .check_lenient(&format!("ip:2001:db8:1:{net:x}::/64"))
                    .is_ok(),
                "lenient checks pass untracked, as with a full store"
            );
        }
        assert_eq!(len(&limiter.network), 10);
        assert!(limiter.check(&key(2, 0)).is_ok(), "other /48s still get in");
        assert!(limiter.check("token:203.0.113.7").is_ok(), "IPv4 too");
        assert!(
            limiter.check(&key(1, 0)).is_err(),
            "tracked keys keep their budget"
        );
        // Once its keys go idle for a full refill, the /48 gets its share back.
        clock.advance(Duration::from_secs(60));
        assert!(limiter.check(&key(1, 500)).is_ok());
        assert_eq!(len(&limiter.network), 1);
    }

    #[test]
    fn retry_after_rounds_up() {
        assert_eq!(retry_after_secs(Duration::from_millis(1_900)), 2);
        assert_eq!(retry_after_secs(Duration::from_secs(30)), 30);
        assert_eq!(retry_after_secs(Duration::from_nanos(1)), 1);
    }
}
