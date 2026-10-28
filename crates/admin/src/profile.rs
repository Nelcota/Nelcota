//! The admin's profile photo (`nelcota.admin_avatar`, migration V4).
//!
//! The panel crops and shrinks the image in the browser and sends it as
//! base64. Only PNG, JPEG or WebP are accepted, recognised by their leading
//! bytes (never by the declared type): SVG or HTML posing as an image does not
//! get through, and the response carries the detected type and `nosniff`.

use axum::{
    Json,
    extract::State,
    http::header,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::contracts::{AvatarCrop, AvatarEditor};
use crate::{AdminState, ApiError};

/// Same limit as the table's CHECK.
pub const MAX_BYTES: usize = 256 * 1024;
const MAX_SOURCE_BYTES: usize = 1024 * 1024;

impl Default for AvatarCrop {
    fn default() -> Self {
        Self {
            x: 0.5,
            y: 0.5,
            zoom: 1.0,
            rotation: 0,
        }
    }
}

impl AvatarCrop {
    fn valid(&self) -> bool {
        self.x.is_finite()
            && self.y.is_finite()
            && self.zoom.is_finite()
            && (0.0..=1.0).contains(&self.x)
            && (0.0..=1.0).contains(&self.y)
            && (1.0..=4.0).contains(&self.zoom)
            && matches!(self.rotation, 0 | 90 | 180 | 270)
    }
}

fn decode_image(encoded: &str, limit: usize) -> Result<(Vec<u8>, &'static str), ApiError> {
    let encoded = encoded.trim();
    if encoded.len() > limit.div_ceil(3) * 4 {
        return Err(
            ApiError::bad_request("photo_too_large", "the photo exceeds its size limit")
                .params(json!({ "max_kb": limit / 1024 })),
        );
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| ApiError::bad_request("invalid_image_base64", "invalid image (base64)"))?;
    if bytes.is_empty() || bytes.len() > limit {
        return Err(
            ApiError::bad_request("photo_too_large", "the photo exceeds its size limit")
                .params(json!({ "max_kb": limit / 1024 })),
        );
    }
    let content_type = sniff(&bytes).ok_or_else(|| {
        ApiError::bad_request("unsupported_image_type", "use a PNG, JPEG or WebP image")
    })?;
    Ok((bytes, content_type))
}

/// Image type from its leading bytes (the format's signature).
pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, ..] => Some("image/png"),
        [0xFF, 0xD8, 0xFF, ..] => Some("image/jpeg"),
        [
            b'R',
            b'I',
            b'F',
            b'F',
            _,
            _,
            _,
            _,
            b'W',
            b'E',
            b'B',
            b'P',
            ..,
        ] => Some("image/webp"),
        _ => None,
    }
}

fn owner(state: &AdminState) -> String {
    state.credentials.email.trim().to_lowercase()
}

/// `GET /admin/api/profile`: email and photo version (ms of the last change,
/// or `null`). The version goes into the image URL, which can then be cached.
pub async fn get(State(state): State<AdminState>) -> Result<Json<Value>, ApiError> {
    let client = state.db.get().await?;
    let row = client
        .query_opt(
            "SELECT (extract(epoch FROM updated_at) * 1000)::bigint
               FROM nelcota.admin_avatar WHERE email = $1",
            &[&owner(&state)],
        )
        .await?;
    let version: Option<i64> = row.map(|r| r.get(0));
    Ok(Json(
        json!({ "email": state.credentials.email, "avatar": version }),
    ))
}

/// `GET /admin/api/profile/avatar`
pub async fn image(State(state): State<AdminState>) -> Result<Response, ApiError> {
    let client = state.db.get().await?;
    let row = client
        .query_opt(
            "SELECT content_type, image FROM nelcota.admin_avatar WHERE email = $1",
            &[&owner(&state)],
        )
        .await?
        .ok_or_else(|| ApiError::not_found("no_profile_photo", "no profile photo"))?;
    let content_type: String = row.get(0);
    let image: Vec<u8> = row.get(1);
    Ok((
        [
            (header::CONTENT_TYPE, content_type),
            // The URL carries the version (`?v=`): changing the photo changes the URL.
            (
                header::CACHE_CONTROL,
                "private, max-age=31536000, immutable".to_owned(),
            ),
        ],
        image,
    )
        .into_response())
}

/// Loads the saved source and framing; older avatars use their existing crop.
pub async fn editor(State(state): State<AdminState>) -> Result<Response, ApiError> {
    let client = state.db.get().await?;
    let row = client
        .query_opt(
            "SELECT a.content_type, a.image, e.content_type, e.image, e.avatar_digest,
                e.crop_x, e.crop_y, e.zoom, e.rotation
         FROM nelcota.admin_avatar a
         LEFT JOIN nelcota.admin_avatar_edits e ON e.email = a.email
         WHERE a.email = $1",
            &[&owner(&state)],
        )
        .await?
        .ok_or_else(|| ApiError::not_found("no_profile_photo", "no profile photo"))?;
    let image: Vec<u8> = row.get(1);
    let digest: Option<Vec<u8>> = row.get(4);
    // An older binary can replace an avatar without updating its editor row.
    let saved = digest.as_deref() == Some(Sha256::digest(&image).as_slice());
    let (content_type, image, crop) = match saved {
        true => (
            row.get::<_, String>(2),
            row.get::<_, Vec<u8>>(3),
            AvatarCrop {
                x: row.get(5),
                y: row.get(6),
                zoom: row.get(7),
                rotation: row.get::<_, i16>(8) as u16,
            },
        ),
        false => (row.get::<_, String>(0), image, AvatarCrop::default()),
    };
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(AvatarEditor {
            source: format!("data:{content_type};base64,{}", STANDARD.encode(image)),
            crop,
        }),
    )
        .into_response())
}

#[derive(Deserialize)]
pub struct Upload {
    /// Base64 image (without the `data:` prefix).
    image: String,
    source: Option<String>,
    crop: Option<AvatarCrop>,
}

/// `PUT /admin/api/profile/avatar`
pub async fn upload(
    State(state): State<AdminState>,
    Json(body): Json<Upload>,
) -> Result<Json<Value>, ApiError> {
    let (bytes, content_type) = decode_image(&body.image, MAX_BYTES)?;
    let edit = match (body.source, body.crop) {
        (None, None) => None,
        (Some(source), Some(crop)) if crop.valid() => {
            let (image, kind) = decode_image(&source, MAX_SOURCE_BYTES)?;
            Some((image, kind, crop))
        }
        _ => {
            return Err(ApiError::bad_request(
                "invalid_avatar_edit",
                "provide a valid source and crop together",
            ));
        }
    };
    let email = owner(&state);
    let mut client = state.db.get().await?;
    let tx = client.transaction().await?;
    let row = tx
        .query_one(
            "INSERT INTO nelcota.admin_avatar (email, content_type, image)
             VALUES ($1, $2, $3)
             ON CONFLICT (email) DO UPDATE
                SET content_type = excluded.content_type,
                    image = excluded.image,
                    updated_at = now()
             RETURNING (extract(epoch FROM updated_at) * 1000)::bigint",
            &[&email, &content_type, &bytes],
        )
        .await?;
    let version: i64 = row.get(0);
    match edit {
        Some((image, kind, crop)) => {
            let digest = Sha256::digest(&bytes).to_vec();
            tx.execute(
                "INSERT INTO nelcota.admin_avatar_edits
                 (email, content_type, image, avatar_digest, crop_x, crop_y, zoom, rotation)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                 ON CONFLICT (email) DO UPDATE SET content_type=excluded.content_type,
                 image=excluded.image, avatar_digest=excluded.avatar_digest,
                 crop_x=excluded.crop_x, crop_y=excluded.crop_y,
                 zoom=excluded.zoom, rotation=excluded.rotation",
                &[
                    &email,
                    &kind,
                    &image,
                    &digest,
                    &crop.x,
                    &crop.y,
                    &crop.zoom,
                    &(crop.rotation as i16),
                ],
            )
            .await?;
        }
        None => {
            tx.execute(
                "DELETE FROM nelcota.admin_avatar_edits WHERE email=$1",
                &[&email],
            )
            .await?;
        }
    }
    tx.commit().await?;
    Ok(Json(json!({ "avatar": version })))
}

/// `DELETE /admin/api/profile/avatar`
pub async fn remove(State(state): State<AdminState>) -> Result<Json<Value>, ApiError> {
    let client = state.db.get().await?;
    client
        .execute(
            "DELETE FROM nelcota.admin_avatar WHERE email = $1",
            &[&owner(&state)],
        )
        .await?;
    Ok(Json(json!({ "avatar": null })))
}

#[cfg(test)]
mod tests {
    use super::sniff;

    #[test]
    fn recognises_the_accepted_formats() {
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR"), Some("image/png"));
        assert_eq!(sniff(b"\xff\xd8\xff\xe0\0\x10JFIF"), Some("image/jpeg"));
        assert_eq!(sniff(b"RIFF\x24\0\0\0WEBPVP8 "), Some("image/webp"));
    }

    #[test]
    fn refuses_everything_else() {
        for bytes in [
            &b"<svg xmlns='http://www.w3.org/2000/svg'/>"[..],
            b"<!doctype html><script>",
            b"GIF89a",
            b"RIFF\x24\0\0\0WAVEfmt ",
            b"",
            b"\x89PN",
        ] {
            assert_eq!(sniff(bytes), None, "{bytes:?}");
        }
    }
}
