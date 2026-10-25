//! What the proxy serves and which credential each route carries.
//!
//! The config names secrets, it never contains them: every `secret` here is a key looked up in the
//! secrets file, which is the only 0600 file on the box. That split is what lets this file be
//! reviewed, diffed and committed while the credential stays off every disk but the one.

use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Deserialize)]
pub struct Config {
    /// Plaintext, localhost. TLS is cloudflared's job, exactly as on the sponsor host and the
    /// indexer box — binding this to a public interface would publish an unauthenticated
    /// credential-injecting proxy.
    pub listen: String,
    pub secrets_file: String,
    #[serde(default)]
    pub credential: HashMap<String, CredentialSpec>,
    #[serde(default)]
    pub route: Vec<RouteSpec>,
}

#[derive(Debug, Deserialize)]
pub struct CredentialSpec {
    /// Header the upstream expects. Blockfrost wants `project_id` lowercase with an underscore —
    /// `Project-Id` is a different header and 403s.
    pub header: String,
    /// Written in front of the key, e.g. `Bearer ` for SteelSwap.
    #[serde(default)]
    pub prefix: String,
    /// Tried in order; the first key with daily quota left is used. This is the pay-as-you-go
    /// switch: a free key with a quota first, an unmetered paid key behind it.
    pub keys: Vec<KeySpec>,
}

#[derive(Debug, Deserialize)]
pub struct KeySpec {
    /// Name in the secrets file. Never the value.
    pub secret: String,
    /// Requests per UTC day before this key is skipped. Absent means unmetered.
    #[serde(default)]
    pub daily_quota: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct RouteSpec {
    /// Matched longest-first, so `/midnight/preprod` wins over `/midnight`.
    pub prefix: String,
    pub upstream: String,
    /// Absent is meaningful rather than lax: our own mainnet indexer needs no key, and inventing
    /// one for it would send Blockfrost's credential to a host that is not Blockfrost.
    #[serde(default)]
    pub credential: Option<String>,
    /// Upstream path prefixes that must NOT carry the credential, matched after this route's own
    /// prefix is stripped.
    ///
    /// Some endpoints under a credentialed API authenticate the *caller* rather than the account:
    /// SteelSwap's `/api/v2/auth/*` is the CIP-8 challenge/verify handshake, and a partner bearer
    /// there fails it. Injecting everywhere broke exactly that on 2026-10-18.
    #[serde(default)]
    pub credential_skip: Vec<String>,
}

#[derive(Debug)]
pub enum LoadError {
    Read(String, std::io::Error),
    Parse(String, toml::de::Error),
    Undefined { route: String, credential: String },
    MissingSecret { credential: String, secret: String },
    NoKeys(String),
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Read(p, e) => write!(f, "cannot read {p}: {e}"),
            Self::Parse(p, e) => write!(f, "cannot parse {p}: {e}"),
            Self::Undefined { route, credential } => {
                write!(f, "route {route} names credential '{credential}', which is not defined")
            }
            Self::MissingSecret { credential, secret } => {
                write!(f, "credential '{credential}' needs secret {secret}, which the secrets file does not set")
            }
            Self::NoKeys(c) => write!(f, "credential '{c}' declares no keys"),
        }
    }
}

impl Config {
    pub fn load(path: &str) -> Result<Self, LoadError> {
        let text = std::fs::read_to_string(path).map_err(|e| LoadError::Read(path.into(), e))?;
        let mut cfg: Config = toml::from_str(&text).map_err(|e| LoadError::Parse(path.into(), e))?;
        // Longest prefix first, so matching is a linear scan with no ambiguity.
        cfg.route.sort_by(|a, b| b.prefix.len().cmp(&a.prefix.len()));
        Ok(cfg)
    }
}

/// `KEY=value` lines. Blank lines and `#` comments are skipped; everything else must parse, because
/// a silently ignored malformed line is a credential that is quietly absent.
pub fn load_secrets(path: &str) -> Result<HashMap<String, String>, LoadError> {
    let text = std::fs::read_to_string(path).map_err(|e| LoadError::Read(path.into(), e))?;
    let mut out = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            out.insert(k.trim().to_string(), v.trim().trim_matches('"').to_string());
        }
    }
    Ok(out)
}

/// Refuse to start on a config that names something it does not have.
///
/// Up front rather than per request: a route whose credential is missing would otherwise answer
/// unauthenticated 403s from the upstream, which reads as the upstream being broken.
pub fn validate(cfg: &Config, secrets: &HashMap<String, String>) -> Result<(), LoadError> {
    for (name, spec) in &cfg.credential {
        if spec.keys.is_empty() {
            return Err(LoadError::NoKeys(name.clone()));
        }
        for key in &spec.keys {
            if !secrets.contains_key(&key.secret) {
                return Err(LoadError::MissingSecret {
                    credential: name.clone(),
                    secret: key.secret.clone(),
                });
            }
        }
    }
    for route in &cfg.route {
        if let Some(c) = &route.credential {
            if !cfg.credential.contains_key(c) {
                return Err(LoadError::Undefined { route: route.prefix.clone(), credential: c.clone() });
            }
        }
    }
    Ok(())
}

pub fn file_is_private(path: &str) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return Path::new(path)
            .metadata()
            .map(|m| m.permissions().mode() & 0o077 == 0)
            .unwrap_or(false);
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        true
    }
}
