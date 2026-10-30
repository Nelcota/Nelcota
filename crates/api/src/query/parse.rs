//! URL parsing and catalog validation.
use super::*;

pub(super) fn column<'a>(table: &'a Table, name: &str) -> Result<&'a Column, QueryError> {
    table.column(name).ok_or_else(|| {
        invalid(format!(
            "column '{name}' does not exist in '{}'",
            table.name
        ))
    })
}

/// `*`, columns and embedded relations: `id,total,customers(name),items(*)`.
/// Relations need the catalog; without it (the panel), they are refused.
/// `depth` is how many embeds this select sits inside.
pub(super) fn parse_select(
    value: &str,
    table: &Table,
    catalog: Option<&Catalog>,
    depth: usize,
) -> Result<Select, QueryError> {
    let mut select = Select {
        star: false,
        columns: Vec::new(),
        embeds: Vec::new(),
    };
    let items = split_top_level(value)?;
    if items.len() > MAX_SELECT_ITEMS {
        return Err(invalid(format!(
            "select accepts at most {MAX_SELECT_ITEMS} items per relation"
        )));
    }
    for item in items.into_iter().map(str::trim) {
        if item.is_empty() {
            return Err(invalid("empty or malformed select"));
        }
        if item == "*" {
            if select.star {
                return Err(invalid("duplicate '*' in select"));
            }
            select.star = true;
            continue;
        }
        if item.contains('(') {
            let catalog = match catalog {
                Some(catalog) => catalog,
                _ => {
                    return Err(invalid("embedding relations is not available here"));
                }
            };
            select
                .embeds
                .push(parse_embed(item, table, catalog, depth + 1)?);
            continue;
        }
        if item.contains(':') {
            return Err(invalid(format!(
                "column aliases are not supported: '{item}'"
            )));
        }
        if select.columns.iter().any(|c| c == item) {
            return Err(invalid(format!("duplicate column '{item}' in select")));
        }
        select.columns.push(column(table, item)?.name.clone());
    }
    // '*' already includes the explicit columns; emit each field only once.
    if select.star {
        select.columns.clear();
    }
    // An embedded key must not collide with a column of the same row.
    let mut keys: Vec<&str> = select.columns.iter().map(String::as_str).collect();
    if select.star {
        keys.extend(table.columns.iter().map(|c| c.name.as_str()));
    }
    for embed in &select.embeds {
        if keys.contains(&embed.alias.as_str()) {
            return Err(invalid(format!(
                "'{}' is already a key of the row: rename the embed with alias:{}(...)",
                embed.alias, embed.table
            )));
        }
        keys.push(&embed.alias);
    }
    fn item_count(select: &Select) -> usize {
        usize::from(select.star)
            + select.columns.len()
            + select
                .embeds
                .iter()
                .map(|embed| 1 + item_count(&embed.select))
                .sum::<usize>()
    }
    if depth == 0 && item_count(&select) > MAX_SELECT_ITEMS {
        return Err(invalid(format!(
            "select accepts at most {MAX_SELECT_ITEMS} items including nested relations"
        )));
    }
    Ok(select)
}

/// `[alias:]table[!hint](select)`, where `select` may embed again, at most
/// [`MAX_EMBED_DEPTH`] levels. The hint picks among several foreign keys:
/// the key's column or the constraint name.
pub(super) fn parse_embed(
    item: &str,
    parent: &Table,
    catalog: &Catalog,
    depth: usize,
) -> Result<Embed, QueryError> {
    if depth > MAX_EMBED_DEPTH {
        return Err(invalid(format!(
            "embeds nested too deep (at most {MAX_EMBED_DEPTH} levels)"
        )));
    }
    let open = item.find('(').unwrap_or_default();
    let inner = item[open + 1..]
        .strip_suffix(')')
        .ok_or_else(|| invalid(format!("malformed embed: '{item}'")))?;
    let head = item[..open].trim();
    let (alias, rest) = match head.split_once(':') {
        Some((alias, rest)) => (Some(alias.trim()), rest.trim()),
        None => (None, head),
    };
    let (name, hint) = match rest.split_once('!') {
        Some((name, hint)) => (name.trim(), Some(hint.trim())),
        None => (rest, None),
    };
    let target = catalog.table(name).ok_or_else(|| {
        invalid(format!(
            "table '{name}' does not exist in the exposed schema"
        ))
    })?;
    let alias = alias.unwrap_or(name);
    if alias.is_empty() || alias.len() > MAX_IDENTIFIER_BYTES || alias.contains('\0') {
        return Err(invalid(format!("invalid embed alias: '{alias}'")));
    }
    let (many, join) = resolve_relation(&catalog.schema, parent, target, hint)?;
    if inner.trim().is_empty() {
        return Err(invalid(format!("empty column list in '{item}'")));
    }
    Ok(Embed {
        alias: alias.to_owned(),
        table: target.name.clone(),
        many,
        join,
        select: parse_select(inner, target, Some(catalog), depth)?,
        filters: Vec::new(),
        order: Vec::new(),
        limit: None,
        offset: None,
    })
}

/// The embed a dotted parameter addresses (`items.qty`, `customers.addresses.order`)
/// and the parameter left for it (`qty`, `order`); `None` when the key does
/// not start with an embed's key.
pub(super) fn embedded_param<'s, 'k>(
    select: &'s mut Select,
    key: &'k str,
) -> Option<(&'s mut Embed, &'k str)> {
    let (head, rest) = key.split_once('.')?;
    let embed = select.embeds.iter_mut().find(|e| e.alias == head)?;
    // A deeper embed takes the parameter when the rest names one; the
    // check runs first so the borrow of `embed` ends on the way back.
    let deeper = rest
        .split_once('.')
        .is_some_and(|(next, _)| embed.select.embeds.iter().any(|e| e.alias == next));
    if deeper {
        return embedded_param(&mut embed.select, rest);
    }
    Some((embed, rest))
}

/// A filter, logic tree, `order`, `limit` or `offset` aimed at an embed.
pub(super) fn parse_embedded_param(
    embed: &mut Embed,
    key: &str,
    value: &str,
    catalog: &Catalog,
) -> Result<(), QueryError> {
    let table = catalog
        .table(&embed.table)
        .expect("embedded table resolved while parsing select");
    let paging = matches!(key, "order" | "limit" | "offset");
    if paging && !embed.many {
        return Err(invalid(format!(
            "'{}' is a single row: {key} only applies to embedded arrays",
            embed.alias
        )));
    }
    match key {
        "order" => embed.order = parse_order(value, table)?,
        "limit" => embed.limit = Some(parse_non_negative("limit", value)?),
        "offset" => embed.offset = Some(parse_non_negative("offset", value)?),
        "or" | "and" | "not.or" | "not.and" => embed.filters.push(parse_logic(table, key, value)?),
        "select" | "on_conflict" => {
            return Err(invalid(format!(
                "{key} cannot be set on an embed: write it inside {}(...)",
                embed.alias
            )));
        }
        _ => embed
            .filters
            .push(Condition::Filter(parse_filter(table, key, value)?)),
    }
    Ok(())
}

/// The foreign key linking `parent` and `target`, in either direction.
/// Returns `(many, join pairs)`; no link or several links are errors.
pub(super) fn resolve_relation(
    schema: &str,
    parent: &Table,
    target: &Table,
    hint: Option<&str>,
) -> Result<(bool, JoinPairs), QueryError> {
    // The same key serves both directions here, so a hint cannot tell parent
    // from children.
    if parent.name == target.name {
        return Err(invalid(format!(
            "embedding '{}' in itself (a self-reference) is not supported yet",
            parent.name
        )));
    }
    let matches_hint = |fk: &ForeignKey| match hint {
        None => true,
        Some(h) => fk.name == h || fk.columns == [h],
    };
    let pairs = |left: &[String], right: &[String]| -> JoinPairs {
        left.iter().cloned().zip(right.iter().cloned()).collect()
    };
    let mut candidates: Vec<(&ForeignKey, bool, JoinPairs)> = Vec::new();
    // This table points there: many-to-one.
    for fk in &parent.foreign_keys {
        if fk.foreign_schema == schema && fk.foreign_table == target.name && matches_hint(fk) {
            candidates.push((fk, false, pairs(&fk.foreign_columns, &fk.columns)));
        }
    }
    // The related table points here: one-to-many.
    for fk in &target.foreign_keys {
        if fk.foreign_schema == schema && fk.foreign_table == parent.name && matches_hint(fk) {
            candidates.push((fk, true, pairs(&fk.columns, &fk.foreign_columns)));
        }
    }
    match candidates.len() {
        0 => Err(invalid(match hint {
            Some(h) => format!(
                "no relationship between '{}' and '{}' matches '{h}'",
                parent.name, target.name
            ),
            None => format!(
                "no foreign key links '{}' and '{}'",
                parent.name, target.name
            ),
        })),
        1 => {
            let (_, many, join) = candidates.remove(0);
            Ok((many, join))
        }
        _ => {
            let options: Vec<String> = candidates
                .iter()
                .map(|(fk, _, _)| match fk.columns.as_slice() {
                    [column] => format!("{}!{column}", target.name),
                    _ => format!("{}!{}", target.name, fk.name),
                })
                .collect();
            Err(invalid(format!(
                "more than one relationship between '{}' and '{}': pick one with {}",
                parent.name,
                target.name,
                options.join(" or ")
            )))
        }
    }
}

pub(super) fn parse_order(value: &str, table: &Table) -> Result<Vec<OrderTerm>, QueryError> {
    let mut terms = Vec::new();
    for term in value.split(',').map(str::trim) {
        let mut parts = term.split('.');
        let name = parts.next().unwrap_or_default();
        let mut order = OrderTerm {
            column: column(table, name)?.name.clone(),
            desc: false,
            nulls_first: None,
        };
        for modifier in parts {
            match modifier {
                "asc" => order.desc = false,
                "desc" => order.desc = true,
                "nullsfirst" => order.nulls_first = Some(true),
                "nullslast" => order.nulls_first = Some(false),
                other => return Err(invalid(format!("invalid order: '{other}'"))),
            }
        }
        terms.push(order);
    }
    Ok(terms)
}

pub(super) fn parse_non_negative(name: &str, value: &str) -> Result<i64, QueryError> {
    value
        .parse::<i64>()
        .ok()
        .filter(|v| *v >= 0)
        .ok_or_else(|| invalid(format!("{name} must be an integer >= 0")))
}

/// `(a,b,"c,d")` → `["a", "b", "c,d"]`. Quotes allow commas and parentheses;
/// `\"` and `\\` escape inside quotes.
pub(super) fn parse_in_list(value: &str) -> Result<Vec<String>, QueryError> {
    let inner = value
        .strip_prefix('(')
        .and_then(|v| v.strip_suffix(')'))
        .ok_or_else(|| invalid("in expects a parenthesized list: in.(a,b)"))?;
    if inner.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut items = Vec::new();
    let mut current = String::new();
    let mut chars = inner.chars().peekable();
    let mut quoted = false;
    let mut was_quoted = false;
    while let Some(c) = chars.next() {
        match c {
            '"' if quoted => quoted = false,
            '"' if !was_quoted && current.trim().is_empty() => {
                quoted = true;
                was_quoted = true;
                current.clear();
            }
            '\\' if quoted => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            ',' if !quoted => {
                items.push(finish_item(&current, was_quoted));
                current.clear();
                was_quoted = false;
            }
            c if was_quoted && !quoted && c.is_whitespace() => {}
            _ if was_quoted && !quoted => {
                return Err(invalid("unexpected characters after quoted in list item"));
            }
            c => current.push(c),
        }
    }
    if quoted {
        return Err(invalid("unclosed quotes in the in list"));
    }
    items.push(finish_item(&current, was_quoted));
    Ok(items)
}

pub(super) fn finish_item(item: &str, quoted: bool) -> String {
    if quoted {
        return item.to_owned();
    }
    item.trim().to_owned()
}

pub(super) fn parse_filter(table: &Table, key: &str, value: &str) -> Result<Filter, QueryError> {
    let col = column(table, key)?;
    let (negate, rest) = match value.strip_prefix("not.") {
        Some(rest) => (true, rest),
        None => (false, value),
    };
    let (op, operand) = rest
        .split_once('.')
        .ok_or_else(|| invalid(format!("invalid filter on '{key}': use operator.value")))?;
    let op = match op {
        "eq" => Op::Cmp(CmpOp::Eq, operand.to_owned()),
        "neq" => Op::Cmp(CmpOp::Neq, operand.to_owned()),
        "gt" => Op::Cmp(CmpOp::Gt, operand.to_owned()),
        "gte" => Op::Cmp(CmpOp::Gte, operand.to_owned()),
        "lt" => Op::Cmp(CmpOp::Lt, operand.to_owned()),
        "lte" => Op::Cmp(CmpOp::Lte, operand.to_owned()),
        "like" | "ilike" => Op::Like {
            insensitive: op == "ilike",
            pattern: like_pattern(operand),
        },
        "in" => Op::In(parse_in_list(operand)?),
        "is" => Op::Is(match operand {
            "null" => IsValue::Null,
            "true" => IsValue::True,
            "false" => IsValue::False,
            "unknown" => IsValue::Unknown,
            _ => return Err(invalid("is accepts null, true, false or unknown")),
        }),
        other => return Err(invalid(format!("unknown operator: '{other}'"))),
    };
    Ok(Filter {
        column: col.name.clone(),
        type_name: col.type_name.clone(),
        negate,
        op,
    })
}

/// Translate the URL wildcard into SQL LIKE: an unescaped `*` matches any
/// text (`%`), and `\*` is a literal `*` (not special in LIKE, so it is
/// emitted bare). Every other backslash escape passes through unchanged for
/// LIKE's default escape character, so `\%`, `\_` and `\\` keep their meaning.
pub(super) fn like_pattern(operand: &str) -> String {
    let mut out = String::with_capacity(operand.len());
    let mut chars = operand.chars();
    while let Some(c) = chars.next() {
        match c {
            '*' => out.push('%'),
            '\\' => match chars.next() {
                Some('*') => out.push('*'),
                Some(next) => {
                    out.push('\\');
                    out.push(next);
                }
                None => out.push('\\'),
            },
            _ => out.push(c),
        }
    }
    out
}

/// `or=(a.eq.1,and(b.gt.2,c.lt.3))`, `and=(...)`, `not.or=(...)`: the
/// PostgREST logic tree. `key` is the query parameter (`or`, `not.and`...).
pub(super) fn parse_logic(table: &Table, key: &str, value: &str) -> Result<Condition, QueryError> {
    let (negate, op) = match key.strip_prefix("not.") {
        Some(op) => (true, op),
        None => (false, key),
    };
    let mut count = 0;
    Ok(Condition::Group {
        any: op == "or",
        negate,
        items: parse_group(table, value, 1, &mut count)?,
    })
}

/// `(item,item,...)` at nesting `depth`.
pub(super) fn parse_group(
    table: &Table,
    value: &str,
    depth: usize,
    count: &mut usize,
) -> Result<Vec<Condition>, QueryError> {
    if depth > MAX_DEPTH {
        return Err(invalid(format!(
            "or/and nested too deep (at most {MAX_DEPTH} levels)"
        )));
    }
    let inner = value
        .strip_prefix('(')
        .and_then(|v| v.strip_suffix(')'))
        .ok_or_else(|| invalid("or/and expects a parenthesized list: or=(a.eq.1,b.eq.2)"))?;
    let items = split_top_level(inner)?;
    if items.iter().all(|i| i.trim().is_empty()) {
        return Err(invalid("empty or/and list"));
    }
    items
        .into_iter()
        .map(|item| parse_logic_item(table, item.trim(), depth, count))
        .collect()
}

/// A group item: a nested `or(...)`/`and(...)` (maybe `not.`), or a filter
/// written `column.operator.value`.
pub(super) fn parse_logic_item(
    table: &Table,
    item: &str,
    depth: usize,
    count: &mut usize,
) -> Result<Condition, QueryError> {
    *count += 1;
    if *count > MAX_CONDITIONS {
        return Err(invalid(format!(
            "too many conditions in or/and (at most {MAX_CONDITIONS})"
        )));
    }
    let (negate, rest) = match item.strip_prefix("not.") {
        Some(rest) if rest.starts_with("or(") || rest.starts_with("and(") => (true, rest),
        _ => (false, item),
    };
    for (prefix, any) in [("or", true), ("and", false)] {
        if let Some(group) = rest.strip_prefix(prefix).filter(|g| g.starts_with('(')) {
            return Ok(Condition::Group {
                any,
                negate,
                items: parse_group(table, group, depth + 1, count)?,
            });
        }
    }
    let (column, filter) = item.split_once('.').ok_or_else(|| {
        invalid(format!(
            "invalid condition '{item}': use column.operator.value"
        ))
    })?;
    parse_filter(table, column, &unquote_operand(filter)?).map(Condition::Filter)
}

/// In a logic tree, a value with commas or parentheses is double-quoted:
/// `name.eq."a,b"`. `in` lists keep their own quoting rules.
pub(super) fn unquote_operand(filter: &str) -> Result<String, QueryError> {
    let (negation, rest) = match filter.strip_prefix("not.") {
        Some(rest) => ("not.", rest),
        None => ("", filter),
    };
    let (op, operand) = match rest.split_once('.') {
        Some((op, operand)) => (op, operand),
        _ => {
            return Ok(filter.to_owned());
        }
    };
    if op == "in" || !operand.starts_with('"') {
        return Ok(filter.to_owned());
    }
    let inner = operand
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .ok_or_else(|| invalid("unclosed quotes in an or/and value"))?;
    let mut value = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => value.extend(chars.next()),
            '"' => return Err(invalid("unescaped quotes in an or/and value")),
            c => value.push(c),
        }
    }
    Ok(format!("{negation}{op}.{value}"))
}

/// Splits on commas outside parentheses and double quotes (`\` escapes inside
/// quotes). Unbalanced parentheses or quotes are an error.
pub(super) fn split_top_level(input: &str) -> Result<Vec<&str>, QueryError> {
    let mut parts = Vec::new();
    let mut depth = 0usize;
    let mut quoted = false;
    let mut escaped = false;
    let mut start = 0;
    for (i, c) in input.char_indices() {
        if quoted {
            match c {
                _ if escaped => escaped = false,
                '\\' => escaped = true,
                '"' => quoted = false,
                _ => {}
            }
            continue;
        }
        match c {
            '"' => quoted = true,
            '(' => depth += 1,
            ')' => {
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| invalid("unbalanced parentheses in or/and"))?;
            }
            ',' if depth == 0 => {
                parts.push(&input[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    if quoted || depth != 0 {
        return Err(invalid("unbalanced parentheses or quotes in or/and"));
    }
    parts.push(&input[start..]);
    Ok(parts)
}

/// `on_conflict=a,b`: catalog columns, no repeats. Whether they form a unique
/// key is Postgres' call (a mismatch is a 400).
pub(super) fn parse_on_conflict(value: &str, table: &Table) -> Result<Vec<String>, QueryError> {
    let mut columns: Vec<String> = Vec::new();
    for name in value.split(',').map(str::trim) {
        if name.is_empty() {
            return Err(invalid("empty or malformed on_conflict"));
        }
        let name = column(table, name)?.name.clone();
        if columns.contains(&name) {
            return Err(invalid(format!("column '{name}' repeated in on_conflict")));
        }
        columns.push(name);
    }
    Ok(columns)
}

/// Parses the query string. Every column mentioned is validated against the
/// table; embedded relations are refused (see [`parse_request_with_relations`]).
pub fn parse_request(pairs: &[(String, String)], table: &Table) -> Result<Request, QueryError> {
    parse(pairs, table, None)
}

/// Like [`parse_request`], also resolving embedded relations in `select=`
/// through the catalog's foreign keys.
pub fn parse_request_with_relations(
    pairs: &[(String, String)],
    table: &Table,
    catalog: &Catalog,
) -> Result<Request, QueryError> {
    parse(pairs, table, Some(catalog))
}

pub(super) fn parse(
    pairs: &[(String, String)],
    table: &Table,
    catalog: Option<&Catalog>,
) -> Result<Request, QueryError> {
    let mut request = Request {
        select: Select::all(),
        filters: Vec::new(),
        order: Vec::new(),
        limit: None,
        offset: None,
        on_conflict: None,
    };
    // `select` first: it defines the embeds that dotted parameters address,
    // wherever it sits in the query string.
    for (_, value) in pairs.iter().filter(|(key, _)| key == "select") {
        request.select = parse_select(value, table, catalog, 0)?;
    }
    for (key, value) in pairs {
        if let Some(catalog) = catalog
            && let Some((embed, rest)) = embedded_param(&mut request.select, key)
        {
            parse_embedded_param(embed, rest, value, catalog)?;
            continue;
        }
        match key.as_str() {
            "select" => {}
            "order" => request.order = parse_order(value, table)?,
            "limit" => request.limit = Some(parse_non_negative("limit", value)?),
            "offset" => request.offset = Some(parse_non_negative("offset", value)?),
            "on_conflict" => request.on_conflict = Some(parse_on_conflict(value, table)?),
            // Logic trees, as in PostgREST: a column named `or`/`and` cannot
            // be filtered directly (it still can inside a tree).
            "or" | "and" | "not.or" | "not.and" => {
                request.filters.push(parse_logic(table, key, value)?);
            }
            _ => request
                .filters
                .push(Condition::Filter(parse_filter(table, key, value)?)),
        }
    }
    Ok(request)
}

// ------------------------------------------------------------------ SQL

#[cfg(test)]
mod tests {
    use super::like_pattern;

    #[test]
    fn like_wildcards_and_escaped_stars() {
        assert_eq!(like_pattern("*abc*"), "%abc%");
        assert_eq!(like_pattern(r"a\*b"), "a*b");
        assert_eq!(like_pattern(r"\**"), "*%");
        // Other escapes keep LIKE's default backslash meaning.
        assert_eq!(like_pattern(r"100\%"), r"100\%");
        assert_eq!(like_pattern(r"a\_b"), r"a\_b");
        // An escaped backslash does not escape the following star.
        assert_eq!(like_pattern(r"a\\*"), r"a\\%");
        assert_eq!(like_pattern(r"a\\\*"), r"a\\*");
        assert_eq!(like_pattern("trailing\\"), "trailing\\");
        assert_eq!(like_pattern("plain"), "plain");
    }
}
