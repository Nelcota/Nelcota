//! Test-only failures at durable operation boundaries; no environment bypass.
use std::cell::RefCell;
#[derive(Default)]
struct State {
    fail_at: Option<usize>,
    labels: Vec<String>,
}
thread_local! { static STATE: RefCell<State> = RefCell::default(); }
pub(super) fn reset(fail_at: Option<usize>) {
    STATE.with(|state| {
        *state.borrow_mut() = State {
            fail_at,
            labels: Vec::new(),
        }
    });
}
pub(super) fn labels() -> Vec<String> {
    STATE.with(|state| state.borrow().labels.clone())
}
pub(super) fn boundary(label: &str) -> anyhow::Result<()> {
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        let index = state.labels.len();
        state.labels.push(label.into());
        if state.fail_at == Some(index) {
            anyhow::bail!("injected PITR recovery boundary {index}: {label}");
        }
        Ok(())
    })
}
