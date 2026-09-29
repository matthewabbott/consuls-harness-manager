//! VAPID (RFC 8292): the notifiers' identity toward push services. One P-256 key, handed to
//! each notifier when it starts and kept by whoever starts them: every subscription is bound to
//! it, so it's never rotated.

use std::collections::HashMap;
use std::sync::Mutex;

use anyhow::{Context, anyhow};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use p256::SecretKey;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use p256::elliptic_curve::Generate;

/// Tokens last this long (push services allow up to 24 h).
const LIFETIME: u64 = 12 * 3600;
/// A cached token is signed again once it has less than this left.
const REFRESH: u64 = 3600;

pub struct Vapid {
    key: SigningKey,
    /// Uncompressed public key, base64url: the `applicationServerKey` phones subscribe with.
    public: String,
    /// `sub` claim: how a push service can reach the sender (a `mailto:` or `https:` URL).
    subject: String,
    /// Signed tokens per push service origin, with their expiry.
    tokens: Mutex<HashMap<String, (String, u64)>>,
}

impl Vapid {
    /// From a base64url private key (as in `NotifierConfig`).
    pub fn from_base64(private_key: &str, subject: String) -> anyhow::Result<Self> {
        let bytes = URL_SAFE_NO_PAD.decode(private_key.trim_end_matches('=')).context("bad VAPID key")?;
        Ok(Self::new(SecretKey::from_slice(&bytes).context("bad VAPID key")?, subject))
    }

    /// A new key, base64url (for a first setup).
    pub fn generate_key() -> String {
        URL_SAFE_NO_PAD.encode(SecretKey::generate().to_bytes())
    }

    pub fn new(secret: SecretKey, subject: String) -> Self {
        let public = URL_SAFE_NO_PAD.encode(secret.public_key().to_sec1_bytes());
        Self { key: SigningKey::from(secret), public, subject, tokens: Mutex::new(HashMap::new()) }
    }

    pub fn public_key(&self) -> &str {
        &self.public
    }

    /// The `Authorization` header for a push to `endpoint` at unix time `now`.
    pub fn authorization(&self, endpoint: &str, now: u64) -> anyhow::Result<String> {
        let aud = audience(endpoint)?;
        let mut tokens = self.tokens.lock().unwrap();
        let token = match tokens.get(&aud) {
            Some((t, exp)) if *exp > now + REFRESH => t.clone(),
            _ => {
                let exp = now + LIFETIME;
                let t = self.token(&aud, exp);
                tokens.insert(aud, (t.clone(), exp));
                t
            }
        };
        Ok(format!("vapid t={token}, k={}", self.public))
    }

    /// An ES256 JWT: `{aud, exp, sub}`.
    fn token(&self, aud: &str, exp: u64) -> String {
        let header = URL_SAFE_NO_PAD.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
        let claims = URL_SAFE_NO_PAD.encode(serde_json::json!({ "aud": aud, "exp": exp, "sub": self.subject }).to_string());
        let input = format!("{header}.{claims}");
        let signature: Signature = self.key.sign(input.as_bytes());
        format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()))
    }
}

/// A push endpoint's origin (`https://web.push.apple.com`), the token's `aud`.
pub fn audience(endpoint: &str) -> anyhow::Result<String> {
    let uri: http::Uri = endpoint.parse().context("bad endpoint")?;
    let scheme = uri.scheme_str().ok_or_else(|| anyhow!("endpoint has no scheme"))?;
    let authority = uri.authority().ok_or_else(|| anyhow!("endpoint has no host"))?;
    Ok(format!("{scheme}://{authority}"))
}

#[cfg(test)]
mod tests {
    use p256::ecdsa::VerifyingKey;
    use p256::ecdsa::signature::Verifier;

    use super::*;

    #[test]
    fn tokens_verify_and_carry_the_claims() {
        let vapid = Vapid::new(SecretKey::generate(), "https://daemon.example.ts.net".into());
        let header = vapid.authorization("https://web.push.apple.com/QGm2x-abc", 1_790_000_000).unwrap();
        let (t, k) = header.strip_prefix("vapid t=").unwrap().split_once(", k=").unwrap();
        assert_eq!(k, vapid.public_key());
        let parts: Vec<&str> = t.split('.').collect();
        assert_eq!(parts.len(), 3);
        let claims: serde_json::Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["aud"], "https://web.push.apple.com");
        assert_eq!(claims["exp"], 1_790_000_000 + LIFETIME);
        assert_eq!(claims["sub"], "https://daemon.example.ts.net");
        let key = VerifyingKey::from_sec1_bytes(&URL_SAFE_NO_PAD.decode(k).unwrap()).unwrap();
        let sig = Signature::from_slice(&URL_SAFE_NO_PAD.decode(parts[2]).unwrap()).unwrap();
        key.verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig).expect("the signature checks out");
        // Cached per origin until close to expiry.
        assert_eq!(vapid.authorization("https://web.push.apple.com/other", 1_790_000_100).unwrap(), header);
        assert_ne!(vapid.authorization("https://web.push.apple.com/x", 1_790_000_000 + LIFETIME - 60).unwrap(), header);
    }

    #[test]
    fn audience_is_the_origin() {
        assert_eq!(audience("https://fcm.googleapis.com/fcm/send/abc").unwrap(), "https://fcm.googleapis.com");
        assert_eq!(audience("http://127.0.0.1:9000/push/1").unwrap(), "http://127.0.0.1:9000");
        assert!(audience("not a url").is_err());
    }

    #[test]
    fn keys_round_trip() {
        let key = Vapid::generate_key();
        let a = Vapid::from_base64(&key, "https://x".into()).unwrap();
        let b = Vapid::from_base64(&key, "https://x".into()).unwrap();
        assert_eq!(a.public_key(), b.public_key());
        assert!(Vapid::from_base64("not a key", "https://x".into()).is_err());
    }
}
