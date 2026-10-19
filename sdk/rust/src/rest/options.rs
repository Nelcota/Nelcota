//! Ordering and upsert options for the public query facade.
#[derive(Clone, Copy, Debug, Default)]
pub struct Order {
    pub descending: bool,
    pub nulls_first: Option<bool>,
}
impl Order {
    pub fn ascending() -> Self {
        Self::default()
    }
    pub fn descending() -> Self {
        Self {
            descending: true,
            nulls_first: None,
        }
    }
    pub fn nulls_first(mut self, first: bool) -> Self {
        self.nulls_first = Some(first);
        self
    }
}

#[derive(Clone, Debug, Default)]
pub struct UpsertOptions {
    pub on_conflict: Vec<String>,
    pub ignore_duplicates: bool,
}
