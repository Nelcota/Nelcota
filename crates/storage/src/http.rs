//! HTTP adapters for object operations, shared by public routes and the panel.
use crate::{
    StorageState, UploadOptions, UploadOutcome, UploadStream, path,
    serve::{self, Access},
    signing,
};
use axum::{
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use nelcota_auth::{Auth, PeerAddr};
use nelcota_core::{
    ApiError, Claims,
    extract::{Json, Query},
};
use percent_encoding::{AsciiSet, CONTROLS, utf8_percent_encode};
use serde::Deserialize;
use serde_json::json;
/// Characters escaped in a path segment of a generated URL.
const SEGMENT: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'`')
    .add(b'{')
    .add(b'}')
    .add(b'/');

fn url_path(kind: &str, bucket: &str, name: &str) -> String {
    let name: Vec<String> = name
        .split('/')
        .map(|s| utf8_percent_encode(s, SEGMENT).to_string())
        .collect();
    format!("/storage/v1/object/{kind}{bucket}/{}", name.join("/"))
}

#[derive(Deserialize)]
pub struct DownloadQuery {
    /// Any value serves the file as an attachment.
    download: Option<String>,
    token: Option<String>,
}

#[derive(Deserialize)]
pub struct SignRequest {
    expires_in: u64,
}

#[derive(Deserialize)]
pub struct ListRequest {
    #[serde(default)]
    prefix: String,
    limit: Option<i64>,
    #[serde(default)]
    offset: i64,
}

/// Converts transport metadata to the upload operation's input.
pub fn upload_options(headers: &HeaderMap, replace: bool) -> UploadOptions {
    UploadOptions {
        content_length: headers
            .get(header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok()),
        content_type: headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned),
        replace,
        client: None,
    }
}
pub fn upload_stream(body: Body) -> UploadStream {
    Box::pin(
        body.into_data_stream()
            .map(|chunk| chunk.map_err(std::io::Error::other)),
    )
}
pub fn upload_response(state: &StorageState, outcome: UploadOutcome) -> Response {
    let status = match outcome.replaced {
        true => StatusCode::OK,
        false => StatusCode::CREATED,
    };
    let public_url = outcome.public.then(|| {
        format!(
            "{}{}",
            state.settings.public_url.as_deref().unwrap_or(""),
            url_path("public/", &outcome.object.bucket, &outcome.object.name)
        )
    });
    let mut body = serde_json::to_value(outcome.object).expect("uploaded object serializes");
    if let Some(url) = public_url {
        body["public_url"] = json!(url);
    }
    (status, Json(body)).into_response()
}
/// The public routes' upload options: transport metadata plus the client
/// address that keys the per-caller upload limit.
fn route_options(
    state: &StorageState,
    headers: &HeaderMap,
    peer: PeerAddr,
    replace: bool,
) -> UploadOptions {
    UploadOptions {
        client: nelcota_auth::client_ip(state.settings.proxy_hops, headers, peer.0),
        ..upload_options(headers, replace)
    }
}
async fn upload(
    state: StorageState,
    claims: Claims,
    bucket: &str,
    name: &str,
    options: UploadOptions,
    body: Body,
) -> Result<Response, ApiError> {
    let outcome = state
        .upload(claims, bucket, name, options, upload_stream(body))
        .await?;
    Ok(upload_response(&state, outcome))
}
pub(crate) async fn create(
    State(state): State<StorageState>,
    Auth(claims): Auth,
    peer: PeerAddr,
    Path((bucket, name)): Path<(String, String)>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    let options = route_options(&state, &headers, peer, false);
    upload(state, claims, &bucket, &name, options, body).await
}
pub(crate) async fn upsert(
    State(state): State<StorageState>,
    Auth(claims): Auth,
    peer: PeerAddr,
    Path((bucket, name)): Path<(String, String)>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    let options = route_options(&state, &headers, peer, true);
    upload(state, claims, &bucket, &name, options, body).await
}
/// Adapts an authorized file read to conditional/ranged HTTP serving.
pub async fn download(
    state: &StorageState,
    claims: &Claims,
    bucket: &str,
    name: &str,
    headers: &HeaderMap,
    attachment: bool,
) -> Result<Response, ApiError> {
    let bucket = path::bucket(bucket)?;
    let name = path::object(name)?;
    serve::respond_current(state, bucket, &name, headers, attachment, || async {
        Ok((state.object(claims, bucket, &name).await?, Access::Private))
    })
    .await
}
pub(crate) async fn private_download(
    State(state): State<StorageState>,
    Auth(claims): Auth,
    Path((bucket, name)): Path<(String, String)>,
    Query(query): Query<DownloadQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    download(
        &state,
        &claims,
        &bucket,
        &name,
        &headers,
        query.download.is_some(),
    )
    .await
}
pub(crate) async fn public(
    State(state): State<StorageState>,
    Path((bucket, name)): Path<(String, String)>,
    Query(query): Query<DownloadQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let bucket = path::bucket(&bucket)?;
    let name = path::object(&name)?;
    serve::respond_current(
        &state,
        bucket,
        &name,
        &headers,
        query.download.is_some(),
        || async { Ok((state.public_object(bucket, &name).await?, Access::Public)) },
    )
    .await
}
pub(crate) async fn sign(
    State(state): State<StorageState>,
    Auth(claims): Auth,
    Path((bucket, name)): Path<(String, String)>,
    Json(request): Json<SignRequest>,
) -> Result<Response, ApiError> {
    let bucket = path::bucket(&bucket)?;
    let name = path::object(&name)?;
    let token = signing::token(&state, &claims, bucket, &name, request.expires_in).await?;
    let url = format!("{}?token={token}", url_path("sign/", bucket, &name));
    Ok(Json(json!({"signed_url": url})).into_response())
}
pub(crate) async fn signed(
    State(state): State<StorageState>,
    Path((bucket, name)): Path<(String, String)>,
    Query(query): Query<DownloadQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let bucket = path::bucket(&bucket)?;
    let name = path::object(&name)?;
    serve::respond_current(
        &state,
        bucket,
        &name,
        &headers,
        query.download.is_some(),
        || async {
            let (object, secs) =
                signing::resolve(&state, bucket, &name, query.token.as_deref()).await?;
            Ok((object, Access::Signed { secs }))
        },
    )
    .await
}
pub(crate) async fn remove(
    State(state): State<StorageState>,
    Auth(claims): Auth,
    Path((bucket, name)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    state.delete(&claims, &bucket, &name).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
pub(crate) async fn list(
    State(state): State<StorageState>,
    Auth(claims): Auth,
    Path(bucket): Path<String>,
    Json(request): Json<ListRequest>,
) -> Result<Response, ApiError> {
    let listing = state
        .list(
            &claims,
            &bucket,
            &request.prefix,
            request.limit,
            request.offset,
        )
        .await?;
    Ok(Json(listing).into_response())
}
