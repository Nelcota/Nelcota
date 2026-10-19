//! The published SDK over real HTTP against the production router and Postgres 17.
mod common;
use common::*;
use nelcota_client::{
    Client,
    auth::UserUpdate,
    rest::{Condition, IsValue, Order, UpsertOptions},
    storage::{BucketSettings, BucketUpdate, ListOptions, OpenOptions, UploadOptions},
};
use serde_json::{Value, json};
use std::net::SocketAddr;

struct Live {
    app: TestApp,
    client: Client,
    task: tokio::task::JoinHandle<()>,
}
impl Live {
    async fn spawn(options: Options) -> Self {
        let app = TestApp::spawn_with(options).await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let router = app.router.clone();
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        Self {
            app,
            client: Client::builder(url).build().unwrap(),
            task,
        }
    }
}
impl Drop for Live {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[tokio::test]
async fn invalid_write_cardinality_never_commits_data() {
    let live = Live::spawn(Options::default()).await;
    let client = live.client.with_access_token(user_token(live.app.user_a));
    let title = "cardinality-preflight-regression";
    let invalid = client
        .from("todos")
        .insert(&json!({"title": title}))
        .single();
    assert!(matches!(
        invalid.execute::<Value>().await,
        Err(nelcota_client::Error::Usage(_))
    ));
    assert!(
        client
            .from("todos")
            .eq("title", title)
            .execute::<Vec<Value>>()
            .await
            .unwrap()
            .data
            .is_empty()
    );
    let row = client
        .from("todos")
        .insert(&json!({"title": title}))
        .select("id,title")
        .single()
        .execute::<Value>()
        .await
        .unwrap();
    assert_eq!(row.data["title"], title);
    assert_eq!(
        client
            .from("todos")
            .eq("title", title)
            .execute::<Vec<Value>>()
            .await
            .unwrap()
            .data
            .len(),
        1
    );
}

#[tokio::test]
async fn crud_rpc_filters_and_user_isolation_over_http() {
    let live = Live::spawn(Options::default()).await;
    let a = live.client.with_access_token(user_token(live.app.user_a));
    let b = live.client.with_access_token(user_token(live.app.user_b));
    let admin = live.client.with_access_token(service_token());
    let rows = a
        .from("todos")
        .select("id,title")
        .count_exact()
        .execute::<Vec<Value>>()
        .await
        .unwrap();
    assert_eq!(rows.data.len(), 1);
    assert_eq!(rows.count, Some(1));
    assert_eq!(
        a.from("todos")
            .head()
            .count_exact()
            .execute::<()>()
            .await
            .unwrap()
            .count,
        Some(1)
    );
    let title = "a,b()\"\\&or=(id.gt.0)";
    let created = a
        .from("todos")
        .insert(&json!({"title":title,"extra":{"x":1}}))
        .select("*")
        .single()
        .execute::<Value>()
        .await
        .unwrap();
    assert_eq!(created.status, 201);
    let id = created.data["id"].as_i64().unwrap();
    assert_eq!(created.data["user_id"], live.app.user_a.to_string());
    assert_eq!(created.data["priority"], "medium");
    for query in [
        a.from("todos").eq("title", title),
        a.from("todos").in_values("title", [title]),
        a.from("todos").or([
            Condition::eq("title", title),
            Condition::all([Condition::eq("title", "absent"), Condition::gt("id", 0)]),
        ]),
        a.from("todos")
            .eq("id", id)
            .or([!Condition::eq("title", "absent")]),
        a.from("todos").or([!!Condition::eq("title", title)]),
        a.from("todos")
            .eq("id", id)
            .or([!Condition::is("done", IsValue::True)]),
        a.from("todos")
            .eq("id", id)
            .or([!Condition::all([Condition::eq("title", "absent")])]),
        a.from("todos")
            .or([!!Condition::any([Condition::eq("title", title)])]),
    ] {
        let rows = query.execute::<Vec<Value>>().await.unwrap();
        assert_eq!(rows.data.len(), 1);
        assert_eq!(rows.data[0]["id"], id);
    }
    assert!(
        b.from("todos")
            .eq("id", id)
            .execute::<Vec<Value>>()
            .await
            .unwrap()
            .data
            .is_empty()
    );
    assert!(
        b.from("todos")
            .update(&json!({"done":true}))
            .eq("id", id)
            .select("id")
            .execute::<Vec<Value>>()
            .await
            .unwrap()
            .data
            .is_empty()
    );
    assert!(
        b.from("todos")
            .delete()
            .eq("id", id)
            .select("id")
            .execute::<Vec<Value>>()
            .await
            .unwrap()
            .data
            .is_empty()
    );
    let theft = a
        .from("todos")
        .update(&json!({"user_id":live.app.user_b}))
        .eq("id", id)
        .execute::<()>()
        .await
        .unwrap_err();
    assert_eq!(theft.status(), Some(403));
    let updated = a
        .from("todos")
        .update(&json!({"extra":null,"done":true}))
        .eq("id", id)
        .select("extra,done")
        .single()
        .execute::<Value>()
        .await
        .unwrap();
    assert!(updated.data["extra"].is_null());
    assert_eq!(updated.data["done"], true);
    assert_eq!(
        live.client
            .rpc("add", &json!({"a":2}))
            .execute::<i32>()
            .await
            .unwrap()
            .data,
        12
    );
    live.client
        .rpc("nothing", &json!({}))
        .execute::<()>()
        .await
        .unwrap();
    assert_eq!(
        a.rpc("who_am_i", &json!({}))
            .execute::<Value>()
            .await
            .unwrap()
            .data["uid"],
        live.app.user_a.to_string()
    );
    assert!(
        live.client
            .from("todos")
            .execute::<Vec<Value>>()
            .await
            .is_err()
    );
    let upsert = admin
        .from("products")
        .upsert(
            &json!({"id":500,"name":"SDK product","price":2}),
            UpsertOptions::default(),
        )
        .select("id,name")
        .single()
        .execute::<Value>()
        .await
        .unwrap();
    assert_eq!(upsert.data["id"], 500);
    let merged = admin
        .from("products")
        .upsert(
            &json!({"id":500,"name":"SDK merged","price":3}),
            UpsertOptions {
                on_conflict: vec!["id".into()],
                ignore_duplicates: false,
            },
        )
        .select("name")
        .single()
        .execute::<Value>()
        .await
        .unwrap();
    assert_eq!(merged.data["name"], "SDK merged");
    let page = live
        .client
        .from("products")
        .select("name")
        .gt("stock", 0)
        .order("price", Order::descending())
        .range(0, 1)
        .execute::<Vec<Value>>()
        .await
        .unwrap();
    assert_eq!(page.data.len(), 2);
    a.from("todos")
        .delete()
        .eq("id", id)
        .execute::<()>()
        .await
        .unwrap();
    assert!(
        a.from("todos")
            .eq("id", id)
            .maybe_single()
            .execute::<Option<Value>>()
            .await
            .unwrap()
            .data
            .is_none()
    );
}

#[tokio::test]
async fn embeds_are_filtered_and_rls_applies_to_related_rows() {
    let live = Live::spawn(Options::default()).await;
    live.app.admin_client.batch_execute("CREATE TABLE public.orders (id int PRIMARY KEY, user_id uuid NOT NULL, product_id int REFERENCES public.products);
        CREATE TABLE public.items (id int PRIMARY KEY, order_id int REFERENCES public.orders, user_id uuid NOT NULL, qty int);
        ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY; ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;
        CREATE POLICY owner ON public.orders TO authenticated USING (user_id = auth.uid());
        CREATE POLICY owner ON public.items TO authenticated USING (user_id = auth.uid());
        GRANT SELECT ON public.orders, public.items TO authenticated;").await.unwrap();
    live.app
        .admin_client
        .execute(
            "INSERT INTO public.orders VALUES (1,$1,1), (2,$2,2)",
            &[&live.app.user_a, &live.app.user_b],
        )
        .await
        .unwrap();
    live.app
        .admin_client
        .execute(
            "INSERT INTO public.items VALUES (1,1,$1,1), (2,1,$1,3), (3,1,$2,10)",
            &[&live.app.user_a, &live.app.user_b],
        )
        .await
        .unwrap();
    live.app.catalog.reload(&live.app.pool).await.unwrap();
    let a = live.client.with_access_token(user_token(live.app.user_a));
    let row = a
        .from("orders")
        .select("id,product:products(name),items(id,qty)")
        .gte("items.qty", 2)
        .order_on(Some("items"), "qty", Order::descending())
        .limit_on(Some("items"), 1)
        .single()
        .execute::<Value>()
        .await
        .unwrap()
        .data;
    assert_eq!(row["id"], 1);
    assert_eq!(row["product"]["name"], "Pen");
    assert_eq!(row["items"], json!([{"id":2,"qty":3}]));
}

#[tokio::test]
async fn login_rotation_recovery_magic_links_and_scoped_tokens() {
    let live = Live::spawn(Options::default()).await;
    let signed = live
        .client
        .auth()
        .sign_up(
            "sdk@example.com",
            "strong-pass-123",
            Some(json!({"name":"SDK"})),
        )
        .await
        .unwrap();
    let old = signed.session.unwrap();
    assert_eq!(signed.user.user_metadata["name"], "SDK");
    assert_eq!(live.client.auth().get_user().await.unwrap().id, old.user.id);
    let mut tasks = Vec::new();
    for _ in 0..12 {
        let auth = live.client.auth();
        tasks.push(tokio::spawn(async move {
            auth.refresh_session().await.unwrap()
        }));
    }
    let mut rotated = String::new();
    for task in tasks {
        let session = task.await.unwrap();
        match rotated.is_empty() {
            true => {
                rotated = session.refresh_token;
            }
            false => {
                assert_eq!(rotated, session.refresh_token);
            }
        }
    }
    assert_ne!(rotated, old.refresh_token);
    let scoped = live.client.with_access_token(old.access_token.clone());
    assert_eq!(scoped.auth().get_user().await.unwrap().id, old.user.id);
    live.client.auth().sign_out().await.unwrap();
    assert!(live.client.auth().get_session().await.unwrap().is_none());
    live.client
        .auth()
        .sign_in_with_password("sdk@example.com", "strong-pass-123")
        .await
        .unwrap();
    live.client
        .auth()
        .request_password_reset("sdk@example.com")
        .await
        .unwrap();
    let mail = live.app.outbox.wait_for(1).await;
    let token = link_token(&mail[0], RECOVERY_URL, "recovery");
    live.client
        .auth()
        .reset_password(&token, "new-strong-pass-123")
        .await
        .unwrap();
    assert!(
        live.client
            .auth()
            .sign_in_with_password("sdk@example.com", "strong-pass-123")
            .await
            .is_err()
    );
    live.client
        .auth()
        .sign_in_with_password("sdk@example.com", "new-strong-pass-123")
        .await
        .unwrap();
    live.client
        .auth()
        .send_magic_link("sdk@example.com")
        .await
        .unwrap();
    let mail = live.app.outbox.wait_for(2).await;
    let token = link_token(&mail[1], MAGIC_LINK_URL, "magiclink");
    let link = nelcota_client::auth::EmailLink {
        kind: nelcota_client::auth::EmailLinkType::MagicLink,
        token,
    };
    assert_eq!(
        live.client
            .auth()
            .verify_email_link(&link)
            .await
            .unwrap()
            .user
            .id,
        old.user.id
    );
}

#[tokio::test]
async fn update_user_merges_metadata_and_changes_the_password() {
    let live = Live::spawn(Options::default()).await;
    let auth = live.client.auth();
    auth.sign_up("upd@example.com", "strong-pass-123", None)
        .await
        .unwrap();
    let data = |value: Value| UserUpdate {
        data: Some(value),
        ..Default::default()
    };
    let user = auth
        .update_user(data(json!({"plan": "pro", "tmp": 1})))
        .await
        .unwrap();
    assert_eq!(json!(user.user_metadata), json!({"plan": "pro", "tmp": 1}));
    let user = auth.update_user(data(json!({"tmp": null}))).await.unwrap();
    assert_eq!(json!(user.user_metadata), json!({"plan": "pro"}));
    let stored = auth.get_session().await.unwrap().unwrap();
    assert_eq!(json!(stored.user.user_metadata), json!({"plan": "pro"}));

    let password = |current: Option<&str>| UserUpdate {
        password: Some("newer-pass-456".into()),
        current_password: current.map(Into::into),
        data: None,
    };
    let missing = auth.update_user(password(None)).await.unwrap_err();
    assert_eq!(missing.code(), "validation_failed");
    let wrong = auth
        .update_user(password(Some("not-the-password")))
        .await
        .unwrap_err();
    assert_eq!(wrong.code(), "invalid_grant");
    auth.update_user(password(Some("strong-pass-123")))
        .await
        .unwrap();
    auth.refresh_session().await.unwrap();
    auth.sign_out().await.unwrap();
    auth.sign_in_with_password("upd@example.com", "newer-pass-456")
        .await
        .unwrap();
    assert!(
        auth.update_user(UserUpdate::default())
            .await
            .unwrap_err()
            .to_string()
            .contains("password or data")
    );
}

#[tokio::test]
async fn signup_confirmation_and_resend() {
    let live = Live::spawn(Options {
        confirm_email: true,
        ..Default::default()
    })
    .await;
    let signed = live
        .client
        .auth()
        .sign_up("confirm-sdk@example.com", "strong-pass-123", None)
        .await
        .unwrap();
    assert!(signed.session.is_none());
    live.app.outbox.wait_for(1).await;
    // Let a second confirmation pass the per-account email cooldown.
    live.app
        .admin_client
        .batch_execute("UPDATE auth.one_time_tokens SET created_at = now() - interval '2 minutes'")
        .await
        .unwrap();
    live.client
        .auth()
        .resend_confirmation("confirm-sdk@example.com")
        .await
        .unwrap();
    let mail = live.app.outbox.wait_for(2).await;
    let token = link_token(&mail[1], CONFIRMATION_URL, "signup");
    let link = nelcota_client::auth::EmailLink {
        kind: nelcota_client::auth::EmailLinkType::Signup,
        token,
    };
    assert_eq!(
        live.client
            .auth()
            .verify_email_link(&link)
            .await
            .unwrap()
            .user
            .id,
        signed.user.id
    );
}

#[tokio::test]
async fn storage_streams_ranges_signed_urls_buckets_and_rls() {
    let live = Live::spawn(Options::default()).await;
    live.app
        .admin_client
        .batch_execute(
            "INSERT INTO storage.buckets (id) VALUES ('docs');
        CREATE POLICY sdk_owner ON storage.objects FOR ALL TO authenticated
        USING (bucket_id='docs' AND (storage.foldername(name))[1]=auth.uid()::text)
        WITH CHECK (bucket_id='docs' AND (storage.foldername(name))[1]=auth.uid()::text);",
        )
        .await
        .unwrap();
    let a = live.client.with_access_token(user_token(live.app.user_a));
    let b = live.client.with_access_token(user_token(live.app.user_b));
    let admin = live.client.with_access_token(service_token());
    let files = a.storage().from("docs").unwrap();
    let name = format!("{}/notes/cafe\u{0301} world?#.txt", live.app.user_a);
    let options = || UploadOptions {
        content_type: Some("text/plain".into()),
        upsert: false,
    };
    let object = files
        .upload_reader(
            &name,
            std::io::Cursor::new(b"hello, nelcota".to_vec()),
            options(),
        )
        .await
        .unwrap();
    assert_eq!(object.size, 14);
    assert_eq!(
        files.download(&name).await.unwrap().as_ref(),
        b"hello, nelcota"
    );
    assert_eq!(
        files
            .upload(&name, "again", options())
            .await
            .unwrap_err()
            .code(),
        "object_exists"
    );
    let part = files
        .open(
            &name,
            OpenOptions {
                range: Some((7, Some(13))),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(part.status(), 206);
    assert_eq!(part.text().await.unwrap(), "nelcota");
    let response = files.open(&name, OpenOptions::default()).await.unwrap();
    let etag = response.headers()["etag"].to_str().unwrap().to_owned();
    assert_eq!(
        files
            .open(
                &name,
                OpenOptions {
                    if_none_match: Some(etag),
                    ..Default::default()
                }
            )
            .await
            .unwrap()
            .status(),
        304
    );
    let list = files
        .list(ListOptions {
            prefix: format!("{}/", live.app.user_a),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(list.folders, vec!["notes"]);
    let list = files
        .list(ListOptions {
            prefix: format!("{}/notes/", live.app.user_a),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(list.objects[0].name, object.name);
    assert_eq!(
        b.storage()
            .from("docs")
            .unwrap()
            .download(&name)
            .await
            .unwrap_err()
            .status(),
        Some(404)
    );
    assert!(
        b.storage()
            .from("docs")
            .unwrap()
            .upload(&name.replace("world", "stolen"), "intrusion", options())
            .await
            .is_err()
    );
    let url = files.create_signed_url(&name, 60).await.unwrap();
    let http = reqwest_client();
    assert_eq!(
        http.get(url).send().await.unwrap().text().await.unwrap(),
        "hello, nelcota"
    );
    files
        .upload(
            &name,
            "replaced",
            UploadOptions {
                upsert: true,
                ..options()
            },
        )
        .await
        .unwrap();
    assert_eq!(files.download(&name).await.unwrap().as_ref(), b"replaced");
    files.remove(&name).await.unwrap();
    assert_eq!(files.download(&name).await.unwrap_err().status(), Some(404));
    let settings = BucketSettings {
        public: true,
        allowed_mime_types: Some(vec!["text/plain".into()]),
        ..Default::default()
    };
    assert_eq!(
        admin
            .storage()
            .create_bucket("sdk-public", settings.clone())
            .await
            .unwrap()
            .id,
        "sdk-public"
    );
    assert!(
        admin
            .storage()
            .get_bucket("sdk-public")
            .await
            .unwrap()
            .public
    );
    assert!(
        admin
            .storage()
            .list_buckets()
            .await
            .unwrap()
            .iter()
            .any(|b| b.id == "sdk-public")
    );
    let public_files = admin.storage().from("sdk-public").unwrap();
    public_files
        .upload("logo.txt", "public", options())
        .await
        .unwrap();
    assert_eq!(
        http.get(public_files.public_url("logo.txt").unwrap())
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "public"
    );
    assert!(admin.storage().delete_bucket("sdk-public").await.is_err());
    public_files.remove("logo.txt").await.unwrap();
    assert!(
        !admin
            .storage()
            .update_bucket(
                "sdk-public",
                BucketUpdate {
                    public: false,
                    file_size_limit: None,
                    allowed_mime_types: None,
                },
            )
            .await
            .unwrap()
            .public
    );
    admin.storage().delete_bucket("sdk-public").await.unwrap();
}

// An HTTP helper for reading sharing URLs; no global TLS provider initialization.
fn reqwest_client() -> reqwest::Client {
    let tls = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_root_certificates(rustls::RootCertStore::empty())
    .with_no_client_auth();
    reqwest::Client::builder()
        .use_preconfigured_tls(tls)
        .build()
        .unwrap()
}

#[tokio::test]
async fn rust_types_cli_reads_the_real_catalog_and_keeps_the_typescript_default() {
    let live = Live::spawn(Options::default()).await;
    #[cfg(unix)]
    let host = match &live.app.admin.get_hosts()[0] {
        tokio_postgres::config::Host::Tcp(host) => host,
        tokio_postgres::config::Host::Unix(_) => panic!("test Postgres uses TCP"),
    };
    #[cfg(not(unix))]
    let tokio_postgres::config::Host::Tcp(host) = &live.app.admin.get_hosts()[0];
    let database_url = format!(
        "postgres://postgres:postgres@{host}:{}/{}",
        live.app.admin.get_ports()[0],
        live.app.admin.get_dbname().unwrap_or("postgres")
    );
    for language in [Some("rust"), None] {
        let database_url = database_url.clone();
        let result = tokio::task::spawn_blocking(move || {
            let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_nelcota"));
            command.arg("types");
            if let Some(language) = language {
                command.args(["--lang", language]);
            }
            command
                .env("NELCOTA_DATABASE_URL", database_url)
                .env("NELCOTA_AUTHENTICATOR_PASSWORD", authenticator_password())
                .env("NELCOTA_JWT_SECRET", JWT_SECRET)
                .env("NELCOTA_DB_SCHEMA", "public")
                .output()
                .unwrap()
        })
        .await
        .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let code = String::from_utf8(result.stdout).unwrap();
        match language.is_some() {
            true => {
                assert!(code.contains("pub mod todos"));
                assert!(code.contains("pub id: i64"));
                assert!(code.contains("pub price: serde_json::Number"));
                assert!(
                    code.contains("skip_serializing_if = \"nelcota_client::Field::is_omitted\"")
                );
            }
            false => {
                assert!(code.contains("export interface Database"));
            }
        }
    }
}
