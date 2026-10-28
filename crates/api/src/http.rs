//! REST transport: URL decoding, preferences and HTTP responses.
use crate::{ApiSettings, CatalogHandle, openapi, operations, query::Resolution};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use deadpool_postgres::Pool;
use nelcota_auth::Auth;
use nelcota_core::ApiError;
use serde_json::Value;
use std::sync::Arc;

fn pairs(raw: Option<String>) -> Vec<(String, String)> {
    form_urlencoded::parse(raw.unwrap_or_default().as_bytes())
        .into_owned()
        .collect()
}

#[derive(Default)]
struct Prefer {
    representation: bool,
    count_exact: bool,
    resolution: Option<Resolution>,
}

impl Prefer {
    fn from_headers(headers: &HeaderMap) -> Self {
        let mut prefer = Prefer::default();
        for value in headers.get_all("prefer") {
            for token in value.to_str().unwrap_or_default().split(',') {
                match token.trim() {
                    "return=representation" => prefer.representation = true,
                    "return=minimal" => prefer.representation = false,
                    "count=exact" => prefer.count_exact = true,
                    "resolution=merge-duplicates" => prefer.resolution = Some(Resolution::Merge),
                    "resolution=ignore-duplicates" => prefer.resolution = Some(Resolution::Ignore),
                    _ => {}
                }
            }
        }
        prefer
    }
}

fn json_response(status: StatusCode, body: String) -> Response {
    (status, [(header::CONTENT_TYPE, "application/json")], body).into_response()
}

pub(crate) async fn openapi(
    State(catalog): State<Arc<CatalogHandle>>,
    Auth(claims): Auth,
) -> Json<Value> {
    Json(openapi::document(&catalog.get(), claims.role()))
}

pub(crate) async fn read(
    State(pool): State<Pool>,
    State(catalog): State<Arc<CatalogHandle>>,
    State(settings): State<Arc<ApiSettings>>,
    Path(name): Path<String>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
    Auth(claims): Auth,
) -> Result<Response, ApiError> {
    let prefer = Prefer::from_headers(&headers);
    let result = operations::read(
        &pool,
        &claims,
        &catalog.get(),
        &name,
        &pairs(raw),
        settings.max_rows,
        prefer.count_exact,
    )
    .await?;
    let total = result
        .total
        .map_or_else(|| "*".to_owned(), |n| n.to_string());
    let range = match result.rows == 0 {
        true => {
            format!("*/{total}")
        }
        false => {
            format!(
                "{}-{}/{total}",
                result.offset,
                result.offset + result.rows - 1
            )
        }
    };
    let mut response = json_response(StatusCode::OK, result.body);
    if let Ok(value) = HeaderValue::from_str(&range) {
        response.headers_mut().insert(header::CONTENT_RANGE, value);
    }
    if prefer.count_exact {
        response.headers_mut().insert(
            "preference-applied",
            HeaderValue::from_static("count=exact"),
        );
    }
    Ok(response)
}

pub(crate) async fn create(
    State(pool): State<Pool>,
    State(catalog): State<Arc<CatalogHandle>>,
    Path(name): Path<String>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
    Auth(claims): Auth,
    bytes: Bytes,
) -> Result<Response, ApiError> {
    let prefer = Prefer::from_headers(&headers);
    let result = operations::create(
        &pool,
        &claims,
        &catalog.get(),
        &name,
        &pairs(raw),
        &bytes,
        operations::WriteOptions {
            representation: prefer.representation,
            resolution: prefer.resolution,
        },
    )
    .await?;
    let mut response = write_response(result.body, StatusCode::CREATED, StatusCode::CREATED);
    if let Some(resolution) = result.resolution {
        let applied = match resolution {
            Resolution::Merge => "resolution=merge-duplicates",
            Resolution::Ignore => "resolution=ignore-duplicates",
        };
        response
            .headers_mut()
            .insert("preference-applied", HeaderValue::from_static(applied));
    }
    apply_write_count(&mut response, result.rows, &prefer);
    Ok(response)
}

fn write_response(body: Option<String>, with_body: StatusCode, minimal: StatusCode) -> Response {
    body.map_or_else(
        || minimal.into_response(),
        |body| json_response(with_body, body),
    )
}

/// PATCH/DELETE response. With `Prefer: count=exact`, `Content-Range:
/// */<rows changed>`, as PostgREST does.
fn change_response(result: operations::ChangeResult, prefer: &Prefer) -> Response {
    let mut response = write_response(result.body, StatusCode::OK, StatusCode::NO_CONTENT);
    apply_write_count(&mut response, result.rows, prefer);
    response
}

fn apply_write_count(response: &mut Response, rows: u64, prefer: &Prefer) {
    if prefer.count_exact {
        let headers = response.headers_mut();
        if let Ok(value) = HeaderValue::from_str(&format!("*/{rows}")) {
            headers.insert(header::CONTENT_RANGE, value);
        }
        headers.append(
            "preference-applied",
            HeaderValue::from_static("count=exact"),
        );
    }
}

pub(crate) async fn update(
    State(pool): State<Pool>,
    State(catalog): State<Arc<CatalogHandle>>,
    Path(name): Path<String>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
    Auth(claims): Auth,
    bytes: Bytes,
) -> Result<Response, ApiError> {
    let prefer = Prefer::from_headers(&headers);
    let result = operations::update(
        &pool,
        &claims,
        &catalog.get(),
        &name,
        &pairs(raw),
        &bytes,
        prefer.representation,
    )
    .await?;
    Ok(change_response(result, &prefer))
}

pub(crate) async fn remove(
    State(pool): State<Pool>,
    State(catalog): State<Arc<CatalogHandle>>,
    Path(name): Path<String>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
    Auth(claims): Auth,
) -> Result<Response, ApiError> {
    let prefer = Prefer::from_headers(&headers);
    let result = operations::remove(
        &pool,
        &claims,
        &catalog.get(),
        &name,
        &pairs(raw),
        prefer.representation,
    )
    .await?;
    Ok(change_response(result, &prefer))
}

pub(crate) async fn rpc(
    State(pool): State<Pool>,
    State(settings): State<Arc<ApiSettings>>,
    State(catalog): State<Arc<CatalogHandle>>,
    Path(name): Path<String>,
    Auth(claims): Auth,
    bytes: Bytes,
) -> Result<Response, ApiError> {
    let body = operations::rpc(
        &pool,
        &claims,
        &catalog.get(),
        &name,
        &bytes,
        settings.max_rows,
    )
    .await?;
    Ok(write_response(body, StatusCode::OK, StatusCode::NO_CONTENT))
}
