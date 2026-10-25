//! Which key to spend, and how much of it has been spent today.
//!
//! Blockfrost's free tier is 50,000 requests per UTC day and the paid tier is bought with ADA, so
//! the cheapest fleet spends the free quota first and only then the paid key. That ordering is the
//! whole point of holding both, and it only works if something counts.
//!
//! ⚠️ The counter is also the **instrument**. Blockfrost does not document whether a WebSocket
//! subscription is metered once at the handshake or per message, and the answer changes the sizing
//! by orders of magnitude. Comparing `/healthz` against their dashboard over the same UTC day
//! answers it from production traffic instead of from guesswork.
//!
//! ⚠️ Counts are in memory and reset on restart. That is honest for a quota the upstream also
//! tracks — our number is a local estimate for switching, never the authority. A restart just means
//! we try the free key again, and the upstream's own 402/429 is the real backstop.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Days since the epoch. Blockfrost resets used requests at midnight UTC, so this is the bucket.
fn utc_day() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() / 86_400).unwrap_or(0)
}

#[derive(Debug)]
struct KeyState {
    secret_name: String,
    value: String,
    daily_quota: Option<u64>,
    used_today: u64,
}

#[derive(Debug)]
struct CredentialState {
    header: String,
    prefix: String,
    keys: Vec<KeyState>,
    day: u64,
    /// Which key the last request spent, so a switch can be logged once instead of per request.
    active: Option<String>,
}

#[derive(Debug)]
pub struct Keyring {
    creds: HashMap<String, Mutex<CredentialState>>,
}

/// The header a request should send. Which key it came from is logged by `take` on a switch, so
/// it does not need to travel with the value.
pub struct Chosen {
    pub header: String,
    pub value: String,
}

#[derive(serde::Serialize)]
pub struct KeyUsage {
    pub secret: String,
    pub used_today: u64,
    pub daily_quota: Option<u64>,
    pub exhausted: bool,
}

impl Keyring {
    pub fn build(cfg: &crate::config::Config, secrets: &HashMap<String, String>) -> Self {
        let mut creds = HashMap::new();
        for (name, spec) in &cfg.credential {
            let keys = spec
                .keys
                .iter()
                .filter_map(|k| {
                    secrets.get(&k.secret).map(|v| KeyState {
                        secret_name: k.secret.clone(),
                        value: v.clone(),
                        daily_quota: k.daily_quota,
                        used_today: 0,
                    })
                })
                .collect();
            creds.insert(
                name.clone(),
                Mutex::new(CredentialState {
                    header: spec.header.clone(),
                    prefix: spec.prefix.clone(),
                    keys,
                    day: utc_day(),
                    active: None,
                }),
            );
        }
        Self { creds }
    }

    /// Spend one request against the first key with quota left, and return what to send.
    ///
    /// Returns `None` only when every key is exhausted — a real state the caller must surface as
    /// 503 rather than forwarding an unauthenticated request that the upstream will 403.
    pub fn take(&self, credential: &str) -> Option<Chosen> {
        let state = self.creds.get(credential)?;
        let mut state = state.lock().ok()?;
        let today = utc_day();
        if state.day != today {
            state.day = today;
            for k in &mut state.keys {
                k.used_today = 0;
            }
        }
        let header = state.header.clone();
        let prefix = state.prefix.clone();

        // The key borrow ends with this block: `state.active` below is a second borrow of the same
        // struct, and the compiler is right to refuse both at once.
        let (secret_name, value, used) = {
            let key = state.keys.iter_mut().find(|k| match k.daily_quota {
                Some(q) => k.used_today < q,
                None => true,
            })?;
            key.used_today += 1;
            (key.secret_name.clone(), key.value.clone(), key.used_today)
        };

        // The free-to-paid switch is the moment this proxy starts costing money. It is worth one
        // line, and exactly one: logging per request would bury it.
        if state.active.as_deref() != Some(secret_name.as_str()) {
            eprintln!("[proxy] credential '{credential}' now spending {secret_name} (request {used} today)");
            state.active = Some(secret_name.clone());
        }

        Some(Chosen { header, value: format!("{prefix}{value}") })
    }

    pub fn usage(&self) -> HashMap<String, Vec<KeyUsage>> {
        let today = utc_day();
        self.creds
            .iter()
            .filter_map(|(name, state)| {
                let state = state.lock().ok()?;
                // A stale day reads as zero rather than yesterday's number, which is what `take`
                // would do on the next request anyway.
                let stale = state.day != today;
                let rows = state
                    .keys
                    .iter()
                    .map(|k| {
                        let used = if stale { 0 } else { k.used_today };
                        KeyUsage {
                            secret: k.secret_name.clone(),
                            used_today: used,
                            daily_quota: k.daily_quota,
                            exhausted: k.daily_quota.is_some_and(|q| used >= q),
                        }
                    })
                    .collect();
                Some((name.clone(), rows))
            })
            .collect()
    }
}
