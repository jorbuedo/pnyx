//! The token-holding proxy: one host in front of the credentialed APIs, so no key is ever bundled
//! into a build.
//!
//! Anything the app reads is public to that build's users — the env manifest has said so about the
//! Blockfrost project id and the SteelSwap partner key for months. This is the server side that
//! makes a *paid* key safe to hold at all: clients call unauthenticated paths here, this injects
//! the credential, and the key exists only in one 0600 file on one box.
//!
//! Shape: plaintext on localhost behind a Cloudflare Tunnel, which is how the sponsor host and the
//! indexer box already work, and the shape `bench/` measured (17 KiB per live connection, 343 MiB
//! at 20k).
//!
//! ⚠️ **Proxying concentrates rate limiting.** Blockfrost's 10 req/s sustained + 500 burst is keyed
//! by the *caller's IP*; behind this, the whole fleet is one IP and therefore one bucket. That is a
//! real ceiling this design introduces and the README does the arithmetic.

mod config;
mod keyring;

use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt, Empty, Full};
use hyper::body::Incoming;
use hyper::header::{HeaderName, HeaderValue, HOST};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode, Uri};
use hyper_util::client::legacy::Client;
use hyper_util::rt::{TokioExecutor, TokioIo};
use std::sync::Arc;
use tokio::io::copy_bidirectional;
use tokio::net::TcpListener;

type Body = BoxBody<Bytes, hyper::Error>;
type Resp = Response<Body>;
type HttpsClient = Client<hyper_rustls::HttpsConnector<hyper_util::client::legacy::connect::HttpConnector>, Body>;

/// Headers that belong to one hop and must not be forwarded. `connection` and `upgrade` are in the
/// list but re-added deliberately on the WebSocket path, which is the one case they are meant to
/// cross.
const HOP_BY_HOP: [&str; 8] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
];

/// Credentials a client might send. Stripped on any path this proxy injects into.
///
/// Two reasons, both real: a client must not be able to override the key we inject, and during the
/// migration the app still carries its own `project_id` for the direct endpoints. Forwarding that
/// would spend the bundled key through the proxy and make the usage counters lie.
///
/// ⚠️ **Not stripped on a `credential_skip` path.** There the caller's own credential is the one
/// that belongs: SteelSwap's `/api/v2/auth/keys` is authorised by the access token the caller just
/// earned from `/auth/cip8/verify`. Stripping it broke the CIP-8 mint on 2026-10-18 in a way that
/// looked like the handshake failing rather than the proxy eating the token.
const CLIENT_CREDENTIALS: [&str; 3] = ["authorization", "project_id", "project-id"];

struct Proxy {
    cfg: config::Config,
    keys: keyring::Keyring,
    client: HttpsClient,
}

fn text(status: StatusCode, body: &str) -> Resp {
    Response::builder()
        .status(status)
        .header("content-type", "text/plain; charset=utf-8")
        .body(Full::new(Bytes::from(body.to_owned())).map_err(|e| match e {}).boxed())
        .expect("static response")
}

/// Strip any `project_id` the caller supplied from the query string.
///
/// The key must travel as a header. A URL reaches logs, error strings and, through the connector's
/// `configuration`, connected dApps — which is exactly why the app moved it to a header in the
/// first place. Letting one back in through the query here would undo that.
fn clean_query(query: Option<&str>) -> Option<String> {
    let q = query?;
    let kept: Vec<&str> = q
        .split('&')
        .filter(|pair| {
            let name = pair.split('=').next().unwrap_or("").to_ascii_lowercase();
            name != "project_id" && !pair.is_empty()
        })
        .collect();
    if kept.is_empty() {
        None
    } else {
        Some(kept.join("&"))
    }
}

/// `upstream_base + (path - prefix) + ?query`.
fn upstream_uri(upstream: &str, prefix: &str, path: &str, query: Option<&str>, raw_query: bool) -> Result<Uri, String> {
    let rest = path.strip_prefix(prefix).unwrap_or(path);
    let base = upstream.trim_end_matches('/');
    let mut url = format!("{base}{rest}");
    let q = if raw_query { query.map(str::to_owned) } else { clean_query(query) };
    if let Some(q) = q {
        url.push('?');
        url.push_str(&q);
    }
    url.parse::<Uri>().map_err(|e| e.to_string())
}

fn is_websocket(req: &Request<Incoming>) -> bool {
    let upgrade = req
        .headers()
        .get("upgrade")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false);
    let connection = req
        .headers()
        .get("connection")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_ascii_lowercase().contains("upgrade"))
        .unwrap_or(false);
    upgrade && connection
}

/// Copy client headers minus hop-by-hop, minus `host` (hyper derives it from the upstream URI, and
/// the client's host names *us*), and minus anything that would smuggle a credential — unless
/// `keep_client_auth`, where the caller's credential is the one the upstream wants.
fn forward_headers(from: &hyper::HeaderMap, to: &mut hyper::HeaderMap, keep_upgrade: bool, keep_client_auth: bool) {
    for (name, value) in from.iter() {
        let lower = name.as_str().to_ascii_lowercase();
        if !keep_client_auth && CLIENT_CREDENTIALS.contains(&lower.as_str()) {
            continue;
        }
        if lower == "host" {
            continue;
        }
        if HOP_BY_HOP.contains(&lower.as_str()) && !(keep_upgrade && (lower == "connection" || lower == "upgrade")) {
            continue;
        }
        to.append(name.clone(), value.clone());
    }
}

impl Proxy {
    fn route(&self, path: &str) -> Option<&config::RouteSpec> {
        // Routes are sorted longest-prefix-first at load, so the first match is the most specific.
        self.cfg.route.iter().find(|r| path.starts_with(&r.prefix))
    }

    async fn handle(self: Arc<Self>, req: Request<Incoming>) -> Result<Resp, hyper::Error> {
        let path = req.uri().path().to_owned();
        let query = req.uri().query().map(str::to_owned);

        if path == "/healthz" {
            let body = serde_json::json!({"ok": true, "usage": self.keys.usage()});
            return Ok(Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "application/json")
                .header("cache-control", "no-store")
                .body(Full::new(Bytes::from(body.to_string())).map_err(|e| match e {}).boxed())
                .expect("healthz"));
        }

        let Some(route) = self.route(&path) else {
            return Ok(text(StatusCode::NOT_FOUND, "no route for this path\n"));
        };

        // Decided before the URI is built: a skipped path is passed through untouched, query
        // included, because "the caller's auth governs here" is the whole meaning of the skip.
        let upstream_path = path.strip_prefix(&route.prefix).unwrap_or(&path).to_owned();
        let skip = route.credential_skip.iter().any(|p| upstream_path.starts_with(p.as_str()));

        let uri = match upstream_uri(&route.upstream, &route.prefix, &path, query.as_deref(), skip) {
            Ok(u) => u,
            Err(e) => {
                eprintln!("[proxy] bad upstream uri for {path}: {e}");
                return Ok(text(StatusCode::BAD_GATEWAY, "bad upstream uri\n"));
            }
        };

        // Resolve the credential BEFORE touching the body: an exhausted keyring is a 503 we answer
        // ourselves, not an unauthenticated request for the upstream to reject as a 403 that would
        // read like the upstream being down.
        let chosen = match &route.credential {
            _ if skip => None,
            None => None,
            Some(name) => match self.keys.take(name) {
                Some(c) => Some(c),
                None => {
                    eprintln!("[proxy] credential '{name}' is exhausted for today; refusing {path}");
                    return Ok(text(StatusCode::SERVICE_UNAVAILABLE, "upstream quota exhausted\n"));
                }
            },
        };

        if is_websocket(&req) {
            return Ok(self.relay_websocket(req, uri, chosen, skip).await);
        }

        let (parts, body) = req.into_parts();

        let mut out = Request::builder().method(parts.method.clone()).uri(uri.clone());
        {
            let headers = out.headers_mut().expect("builder headers");
            forward_headers(&parts.headers, headers, false, skip);
            if let Some(c) = &chosen {
                match (HeaderName::try_from(c.header.as_str()), HeaderValue::try_from(c.value.as_str())) {
                    (Ok(n), Ok(mut v)) => {
                        v.set_sensitive(true); // keeps it out of hyper's Debug output
                        headers.insert(n, v);
                    }
                    _ => eprintln!("[proxy] credential header '{}' is not a valid header", c.header),
                }
            }
        }

        let upstream_req = match out.body(body.boxed()) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[proxy] cannot build upstream request: {e}");
                return Ok(text(StatusCode::BAD_GATEWAY, "cannot build upstream request\n"));
            }
        };

        match self.client.request(upstream_req).await {
            Ok(res) => {
                let (rp, rb) = res.into_parts();
                let mut built = Response::builder().status(rp.status);
                {
                    let headers = built.headers_mut().expect("builder headers");
                    for (name, value) in rp.headers.iter() {
                        if HOP_BY_HOP.contains(&name.as_str().to_ascii_lowercase().as_str()) {
                            continue;
                        }
                        headers.append(name.clone(), value.clone());
                    }
                }
                Ok(built.body(rb.boxed()).expect("response"))
            }
            Err(e) => {
                // Every error path logs: a 502 with no line is indistinguishable from an upstream
                // that answered one.
                eprintln!("[proxy] upstream {uri} failed: {e}");
                Ok(text(StatusCode::BAD_GATEWAY, "upstream request failed\n"))
            }
        }
    }

    /// Relay a WebSocket: handshake upstream with the credential as a HEADER, then splice.
    ///
    /// ⚠️ This is the one place the proxy removes a long-standing compromise rather than just
    /// moving it. A browser/RN `WebSocket` cannot set a header, so the app had to put
    /// `?project_id=` in the socket URL. A server can, so upstream gets the header form and the
    /// client's URL carries no credential at all.
    async fn relay_websocket(
        self: Arc<Self>,
        mut req: Request<Incoming>,
        uri: Uri,
        chosen: Option<keyring::Chosen>,
        skip: bool,
    ) -> Resp {
        let client_upgrade = hyper::upgrade::on(&mut req);

        let mut out = Request::builder().method(req.method().clone()).uri(uri.clone());
        {
            let headers = out.headers_mut().expect("builder headers");
            forward_headers(req.headers(), headers, true, skip);
            if let Some(host) = uri.authority().map(|a| a.as_str().to_owned()) {
                if let Ok(v) = HeaderValue::try_from(host) {
                    headers.insert(HOST, v);
                }
            }
            if let Some(c) = &chosen {
                match (HeaderName::try_from(c.header.as_str()), HeaderValue::try_from(c.value.as_str())) {
                    (Ok(n), Ok(mut v)) => {
                        v.set_sensitive(true);
                        headers.insert(n, v);
                    }
                    _ => eprintln!("[proxy] credential header '{}' is not a valid header", c.header),
                }
            }
        }

        let handshake = match out.body(Empty::<Bytes>::new().map_err(|e| match e {}).boxed()) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[proxy] cannot build ws handshake: {e}");
                return text(StatusCode::BAD_GATEWAY, "cannot build ws handshake\n");
            }
        };

        let mut upstream_res = match self.client.request(handshake).await {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[proxy] ws handshake to {uri} failed: {e}");
                return text(StatusCode::BAD_GATEWAY, "ws handshake failed\n");
            }
        };

        if upstream_res.status() != StatusCode::SWITCHING_PROTOCOLS {
            let status = upstream_res.status();
            eprintln!("[proxy] ws upstream {uri} refused the upgrade with {status}");
            return text(StatusCode::BAD_GATEWAY, "upstream refused the websocket upgrade\n");
        }

        let upstream_upgrade = hyper::upgrade::on(&mut upstream_res);
        tokio::spawn(async move {
            match (client_upgrade.await, upstream_upgrade.await) {
                (Ok(down), Ok(up)) => {
                    let mut down = TokioIo::new(down);
                    let mut up = TokioIo::new(up);
                    // After the 101 a WebSocket is two byte streams. No framing to parse, which is
                    // what makes the per-connection cost the two copy buffers and nothing else.
                    if let Err(e) = copy_bidirectional(&mut down, &mut up).await {
                        eprintln!("[proxy] ws relay ended: {e}");
                    }
                }
                (Err(e), _) => eprintln!("[proxy] client ws upgrade failed: {e}"),
                (_, Err(e)) => eprintln!("[proxy] upstream ws upgrade failed: {e}"),
            }
        });

        let mut built = Response::builder().status(StatusCode::SWITCHING_PROTOCOLS);
        {
            let headers = built.headers_mut().expect("builder headers");
            for (name, value) in upstream_res.headers().iter() {
                headers.append(name.clone(), value.clone());
            }
        }
        built
            .body(Empty::<Bytes>::new().map_err(|e| match e {}).boxed())
            .expect("101 response")
    }
}

#[tokio::main]
async fn main() {
    let config_path = std::env::args().nth(1).unwrap_or_else(|| "/etc/pnyx-proxy/proxy.toml".into());

    let cfg = match config::Config::load(&config_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[proxy] {e}");
            std::process::exit(1);
        }
    };
    let secrets = match config::load_secrets(&cfg.secrets_file) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[proxy] {e}");
            std::process::exit(1);
        }
    };
    // Refuse to run off a world-readable secrets file. The whole point of this process is that the
    // credential lives in exactly one place that only it can read.
    if !config::file_is_private(&cfg.secrets_file) {
        eprintln!("[proxy] {} is group- or world-readable; chmod 600 it", cfg.secrets_file);
        std::process::exit(1);
    }
    if let Err(e) = config::validate(&cfg, &secrets) {
        eprintln!("[proxy] {e}");
        std::process::exit(1);
    }

    if rustls::crypto::ring::default_provider().install_default().is_err() {
        eprintln!("[proxy] a rustls crypto provider was already installed; continuing");
    }

    let https = hyper_rustls::HttpsConnectorBuilder::new()
        .with_webpki_roots()
        .https_or_http()
        .enable_http1()
        .build();
    let client: HttpsClient = Client::builder(TokioExecutor::new()).build(https);

    let listen = cfg.listen.clone();
    let routes: Vec<String> = cfg
        .route
        .iter()
        .map(|r| format!("{} -> {}{}", r.prefix, r.upstream, r.credential.as_ref().map(|c| format!(" [{c}]")).unwrap_or_default()))
        .collect();
    let keys = keyring::Keyring::build(&cfg, &secrets);
    let proxy = Arc::new(Proxy { cfg, keys, client });

    let listener = match TcpListener::bind(&listen).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[proxy] cannot bind {listen}: {e}");
            std::process::exit(1);
        }
    };
    eprintln!("[proxy] listening on {listen}");
    for r in &routes {
        eprintln!("[proxy]   {r}");
    }

    loop {
        let (stream, _) = match listener.accept().await {
            Ok(x) => x,
            Err(e) => {
                eprintln!("[proxy] accept failed: {e}");
                continue;
            }
        };
        let proxy = proxy.clone();
        tokio::spawn(async move {
            let io = TokioIo::new(stream);
            let service = service_fn(move |req| proxy.clone().handle(req));
            if let Err(e) = http1::Builder::new().serve_connection(io, service).with_upgrades().await {
                // A client that walks away mid-request is routine; log at the same level anyway
                // rather than swallow, so a pattern is visible.
                eprintln!("[proxy] connection ended: {e}");
            }
        });
    }
}
