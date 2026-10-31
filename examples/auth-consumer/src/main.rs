use deadpool_postgres::{Manager, Pool, Runtime};
use nelcota_auth::{AuthSettings, AuthState, EmailLinks, Keys, Passwords};
use std::{env, sync::Arc};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut admin: tokio_postgres::Config = env::var("AUTH_DATABASE_URL")?.parse()?;
    admin.connect_timeout(std::time::Duration::from_secs(5));
    let password = env::var("AUTH_DATABASE_PASSWORD")?;
    let private_key = env::var("AUTH_PRIVATE_KEY")?;
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        nelcota_auth::bootstrap(&admin, &password, 5),
    )
    .await??;
    let mut request = admin.clone();
    request.user("authenticator").password(password);
    let pool = Pool::builder(Manager::new(request, tokio_postgres::NoTls))
        .max_size(4)
        .runtime(Runtime::Tokio1)
        .wait_timeout(Some(std::time::Duration::from_secs(5)))
        .create_timeout(Some(std::time::Duration::from_secs(5)))
        .build()?;
    let state = AuthState::new(
        pool.clone(),
        Arc::new(Keys::new(Some(&private_key), None)?),
        Arc::new(Passwords::new(2)),
        AuthSettings {
            issuer: "auth-consumer".into(),
            access_ttl_secs: 900,
            refresh_ttl_days: 30,
            signup_enabled: true,
            proxy_hops: 0,
            links: EmailLinks::default(),
        },
        60,
    )?;
    let pruner = nelcota_auth::pruner_task(pool.clone());
    let listener =
        tokio::net::TcpListener::bind(env::var("AUTH_BIND").unwrap_or("127.0.0.1:8080".into()))
            .await?;
    println!("Listening on {}", listener.local_addr()?);
    let router =
        nelcota_auth::router(state).layer(tower_http::timeout::TimeoutLayer::with_status_code(
            axum::http::StatusCode::GATEWAY_TIMEOUT,
            std::time::Duration::from_secs(10),
        ));
    let result = axum::serve(
        listener,
        router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await;
    pruner.abort();
    let _ = pruner.await;
    pool.close();
    result?;
    Ok(())
}
