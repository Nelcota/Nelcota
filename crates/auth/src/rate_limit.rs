//! In-memory rate limit per key (IP, email): `limit` requests per minute.
//!
//! Uses governor's GCRA: the budget refills continuously (one request every
//! `60 / limit` seconds) instead of resetting at the turn of a fixed minute,
//! which let a client spend almost twice the limit across the boundary.
//! Still in memory: a single binary per install needs no Redis (D26).
//!
//! Keys live in two bounded stores. Network keys (an IP or an IPv6 /64) cost
//! an attacker one address each. Account keys contain an email the client
//! picks freely, so they are kept apart: a flood of made-up emails can fill
//! only the account store, never the one the per-IP budgets rely on.
//!
//! Password attempts also have an account-wide budget, `ACCOUNT_BUDGET_FACTOR`
//! times the per-IP one, so many addresses cannot guess one account's password
//! much faster than one address could, while one address alone cannot use it
//! up. Over that budget the caller decides (see `password_grant`): networks
//! where the account already has sessions get through after a growing delay.

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
    last_cleanup: C::Instant,
    #[cfg(test)]
    cleanups: usize,
}

/// One bounded key store, whose keys share one quota.
struct Store<C: Clock> {
    state: RwLock<State<C>>,
    quota: Quota,
    capacity: usize,
    name: &'static str,
}

impl<C: Clock> Store<C> {
    fn new(name: &'static str, quota: Quota, capacity: usize, start: C::Instant) -> Self {
        Store {
            state: RwLock::new(State {
                entries: HashMap::new(),
                last_cleanup: start,
                #[cfg(test)]
                cleanups: 0,
            }),
            quota,
            capacity,
            name,
        }
    }
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
            network: Store::new("network", network, capacity, start),
            accounts: Store::new("account", accounts, capacity, start),
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
        {
            let state = store.state.read().unwrap_or_else(|e| e.into_inner());
            if let Some(entry) = state.entries.get(key) {
                return self.outcome(entry);
            }
        }

        // Serialize new-key admission only. Existing keys share a read lock
        // and governor still atomically enforces each independent GCRA budget.
        let mut state = store.state.write().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = state.entries.get(key) {
            return self.outcome(entry);
        }
        let now = self.clock.now();
        if state.entries.len() >= store.capacity
            && now.duration_since(state.last_cleanup) >= CLEANUP_INTERVAL.into()
        {
            let elapsed = now.duration_since(self.start).as_u64();
            state.entries.retain(|_, entry| {
                elapsed.saturating_sub(entry.last_accepted.load(Ordering::Relaxed))
                    < FULL_REFILL.as_nanos() as u64
            });
            state.last_cleanup = now;
            #[cfg(test)]
            {
                state.cleanups += 1;
            }
            if state.entries.len() >= store.capacity {
                // At most once per second per store, so it cannot flood logs.
                tracing::warn!(
                    store = store.name,
                    capacity = store.capacity,
                    "rate limit key store is full"
                );
            }
        }
        // Never drop a recent entry to make room: its next attempt would
        // obtain a fresh burst and bypass the quota.
        if state.entries.len() >= store.capacity {
            return Admission::Full;
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

    /// `Ok` while the key has budget; `Err(wait)` until its budget refills.
    /// For network keys (an IP from `ip_key`, optionally with a prefix).
    /// Unknown keys are refused while the store is full, with a retry hint.
    /// Each network holds a handful of keys (one per endpoint), so filling
    /// the store takes thousands of distinct networks (IPv4 addresses or IPv6
    /// /64s) kept busy every minute: costly, but within reach of an attacker
    /// with a large IPv6 allocation.
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
    /// `Some(wait)` once it is spent. A full account store counts as spent
    /// for accounts it does not track yet (with a one-second hint): letting
    /// them through untracked would let made-up emails switch the budget off.
    /// The caller admits a spent budget only for networks the account knows,
    /// after `login_delay`.
    pub(crate) fn login_budget(&self, account: &str) -> Option<Duration> {
        let key = format!("login:{account}");
        match self.admit(&self.accounts, &key) {
            Admission::Accepted => {
                self.reset_login_delay(&key);
                None
            }
            Admission::Limited(wait) => Some(wait),
            Admission::Full => Some(CLEANUP_INTERVAL),
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
    fn a_full_account_store_counts_as_a_spent_budget() {
        let clock = FakeRelativeClock::default();
        let limiter = RateLimiter::with_capacity(1, clock.clone(), 2);
        assert_eq!(limiter.login_budget("a"), None);
        assert_eq!(limiter.login_budget("b"), None);
        assert_eq!(
            limiter.login_budget("made-up"),
            Some(CLEANUP_INTERVAL),
            "untracked accounts cannot slip past the budget"
        );
        assert_eq!(limiter.login_delay("made-up"), Duration::ZERO);
        assert_eq!(len(&limiter.accounts), 2);
        clock.advance(Duration::from_secs(60));
        assert_eq!(limiter.login_budget("made-up"), None);
        assert_eq!(len(&limiter.accounts), 1, "idle keys were cleaned up");
    }

    #[test]
    fn retry_after_rounds_up() {
        assert_eq!(retry_after_secs(Duration::from_millis(1_900)), 2);
        assert_eq!(retry_after_secs(Duration::from_secs(30)), 30);
        assert_eq!(retry_after_secs(Duration::from_nanos(1)), 1);
    }
}
