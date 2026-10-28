//! Panel profile integration scenarios.
use crate::common::panel::{JSON, get, login, send, sql};
use crate::common::*;
use axum::http::{Method, StatusCode, header};
use serde_json::json;

#[tokio::test]
async fn admin_profile_photo() {
    // Minimal PNG (signature + start of IHDR) and an SVG, in base64.
    const PNG: &str = "iVBORw0KGgoAAAANSUhEUg==";
    const SVG: &str = "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";
    let app = TestApp::spawn().await;

    for path in [
        "/admin/api/profile",
        "/admin/api/profile/avatar",
        "/admin/api/profile/avatar/editor",
    ] {
        let reply = app.raw(Method::GET, path, &[], String::new()).await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{path}");
    }

    let cookie = login(&app).await;
    let profile = get(&app, "/admin/api/profile", &cookie).await;
    assert_eq!(profile.status, StatusCode::OK, "{}", profile.text);
    assert_eq!(profile.body["email"], ADMIN_EMAIL);
    assert!(profile.body["avatar"].is_null());
    let reply = get(&app, "/admin/api/profile/avatar", &cookie).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);

    // Only PNG, JPEG or WebP recognised by their bytes; size is limited.
    let too_big = "A".repeat(349_528); // 262,146 decoded bytes
    for image in [SVG, "not base64!", "", too_big.as_str()] {
        let reply = send(
            &app,
            Method::PUT,
            "/admin/api/profile/avatar",
            &cookie,
            json!({ "image": image }),
        )
        .await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{}", reply.text);
    }

    // CSRF: another origin does not change the photo.
    let reply = app
        .raw(
            Method::PUT,
            "/admin/api/profile/avatar",
            &[
                ("cookie", &cookie),
                JSON,
                ("origin", "https://malicious.example"),
            ],
            json!({ "image": PNG }).to_string(),
        )
        .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);

    let reply = send(
        &app,
        Method::PUT,
        "/admin/api/profile/avatar",
        &cookie,
        json!({ "image": PNG }),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text);
    let version = reply.body["avatar"].as_i64().expect("photo version");
    let profile = get(&app, "/admin/api/profile", &cookie).await;
    assert_eq!(profile.body["avatar"], version);

    let reply = get(&app, "/admin/api/profile/avatar", &cookie).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.headers[header::CONTENT_TYPE], "image/png");
    assert_eq!(reply.headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert!(reply.text.ends_with("IHDR"));
    let editor = get(&app, "/admin/api/profile/avatar/editor", &cookie).await;
    assert_eq!(editor.status, StatusCode::OK);
    assert_eq!(editor.headers[header::CACHE_CONTROL], "no-store");
    assert_eq!(
        editor.body["source"],
        format!("data:image/png;base64,{PNG}")
    );
    assert_eq!(
        editor.body["crop"],
        json!({"x":0.5,"y":0.5,"zoom":1.0,"rotation":0})
    );

    // The table is out of reach of the API roles.
    let out = sql(
        &app,
        &cookie,
        "select has_schema_privilege('anon', 'nelcota', 'usage'),
                has_schema_privilege('authenticated', 'nelcota', 'usage'),
                has_schema_privilege('service_role', 'nelcota', 'usage')",
    )
    .await;
    assert_eq!(out["results"][0]["rows"], json!([["f", "f", "f"]]));

    let reply = send(
        &app,
        Method::DELETE,
        "/admin/api/profile/avatar",
        &cookie,
        json!({}),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert!(reply.body["avatar"].is_null());
    let reply = get(&app, "/admin/api/profile/avatar", &cookie).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn avatar_editor_retains_private_source_and_framing_atomically() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let app = TestApp::spawn().await;
    let cookie = login(&app).await;
    let image = STANDARD.encode(b"\x89PNG\r\n\x1a\nrendered avatar");
    let source = STANDARD.encode(b"\x89PNG\r\n\x1a\nuncropped source");
    let crop = json!({"x":0.3,"y":0.7,"zoom":2.0,"rotation":90});
    let payload = json!({"image":image,"source":source,"crop":crop});
    let saved = send(
        &app,
        Method::PUT,
        "/admin/api/profile/avatar",
        &cookie,
        payload.clone(),
    )
    .await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.text);
    let editor = get(&app, "/admin/api/profile/avatar/editor", &cookie).await;
    assert_eq!(editor.status, StatusCode::OK);
    assert_eq!(editor.headers[header::CACHE_CONTROL], "no-store");
    assert_eq!(
        editor.body["source"],
        format!("data:image/png;base64,{source}")
    );
    assert_eq!(editor.body["crop"], crop);

    for role in ["anon", "authenticated", "service_role", "nelcota_auth"] {
        let allowed: bool = app
            .admin_client
            .query_one(
                "SELECT has_table_privilege($1, 'nelcota.admin_avatar_edits', 'SELECT')",
                &[&role],
            )
            .await
            .unwrap()
            .get(0);
        assert!(!allowed, "{role} must not read private editor sources");
    }
    let mut invalid = vec![
        json!({"image":image,"source":source}),
        json!({"image":image,"crop":crop}),
        json!({"image":image,"source":STANDARD.encode(b"<svg/>"),"crop":crop}),
        json!({"image":image,"source":"A".repeat(1_398_104),"crop":crop}),
    ];
    for (key, value) in [
        ("x", -0.1),
        ("y", 1.1),
        ("zoom", 0.9),
        ("zoom", 4.1),
        ("rotation", 45.0),
    ] {
        let mut bad = payload.clone();
        bad["crop"][key] = json!(value);
        // Rotation is an integer on the wire.
        if key == "rotation" {
            bad["crop"][key] = json!(45);
        }
        invalid.push(bad);
    }
    for body in invalid {
        let response = send(
            &app,
            Method::PUT,
            "/admin/api/profile/avatar",
            &cookie,
            body,
        )
        .await;
        assert_eq!(
            response.status,
            StatusCode::BAD_REQUEST,
            "{}",
            response.text
        );
        let unchanged = get(&app, "/admin/api/profile/avatar/editor", &cookie).await;
        assert_eq!(unchanged.body, editor.body);
        assert_eq!(
            get(&app, "/admin/api/profile", &cookie).await.body["avatar"],
            saved.body["avatar"]
        );
    }

    // Old upload clients replace the photo without retaining unrelated editor data.
    let legacy = send(
        &app,
        Method::PUT,
        "/admin/api/profile/avatar",
        &cookie,
        json!({"image":image}),
    )
    .await;
    assert_eq!(legacy.status, StatusCode::OK);
    let remaining: i64 = app
        .admin_client
        .query_one("SELECT count(*) FROM nelcota.admin_avatar_edits", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(remaining, 0);
    let legacy = get(&app, "/admin/api/profile/avatar/editor", &cookie).await;
    assert_eq!(
        legacy.body["source"],
        format!("data:image/png;base64,{image}")
    );
    assert_eq!(legacy.body["crop"]["zoom"], 1.0);

    send(
        &app,
        Method::PUT,
        "/admin/api/profile/avatar",
        &cookie,
        payload,
    )
    .await;
    let removed = send(
        &app,
        Method::DELETE,
        "/admin/api/profile/avatar",
        &cookie,
        json!({}),
    )
    .await;
    assert_eq!(removed.status, StatusCode::OK);
    let remaining: i64 = app
        .admin_client
        .query_one("SELECT count(*) FROM nelcota.admin_avatar_edits", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(remaining, 0);
    assert_eq!(
        get(&app, "/admin/api/profile/avatar/editor", &cookie)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn a_photo_replaced_by_an_older_binary_cannot_reopen_an_unrelated_source() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let app = TestApp::spawn().await;
    let cookie = login(&app).await;
    let image = STANDARD.encode(b"\x89PNG\r\n\x1a\nfirst avatar");
    let source = STANDARD.encode(b"\x89PNG\r\n\x1a\nfirst source");
    let saved = send(
        &app,
        Method::PUT,
        "/admin/api/profile/avatar",
        &cookie,
        json!({"image":image,"source":source,"crop":{"x":0.4,"y":0.6,"zoom":2.0,"rotation":180}}),
    )
    .await;
    assert_eq!(saved.status, StatusCode::OK);
    let replacement = b"\x89PNG\r\n\x1a\nlegacy replacement".to_vec();
    app.admin_client
        .execute("UPDATE nelcota.admin_avatar SET image=$1", &[&replacement])
        .await
        .unwrap();
    let editor = get(&app, "/admin/api/profile/avatar/editor", &cookie).await;
    assert_eq!(
        editor.body["source"],
        format!("data:image/png;base64,{}", STANDARD.encode(replacement))
    );
    assert_eq!(
        editor.body["crop"],
        json!({"x":0.5,"y":0.5,"zoom":1.0,"rotation":0})
    );
}
