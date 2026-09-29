//! Web Push message encryption (RFC 8291: the `aes128gcm` content coding of RFC 8188, keyed by
//! ECDH with the subscription's P-256 key). Only the phone that made the subscription can read
//! what the push service carries.

use aes_gcm::aead::Aead;
use aes_gcm::{Aes128Gcm, KeyInit, Nonce};
use anyhow::{Context, anyhow, bail};
use hkdf::Hkdf;
use p256::elliptic_curve::Generate;
use p256::elliptic_curve::ecdh::diffie_hellman;
use p256::{PublicKey, SecretKey};
use sha2::Sha256;

/// The record size we declare; a push message is one record (they're at most 4 KB).
const RS: u32 = 4096;
/// Salt (16) + record size (4) + key id length (1) + key id (65).
const HEADER: usize = 86;

/// Encrypts `plaintext` for a subscription (`ua_public`: its `p256dh` key, 65 bytes
/// uncompressed; `auth`: its 16-byte secret) with a fresh key and salt.
pub fn encrypt(ua_public: &[u8], auth: &[u8], plaintext: &[u8]) -> anyhow::Result<Vec<u8>> {
    let mut salt = [0u8; 16];
    getrandom::fill(&mut salt).map_err(|e| anyhow!("no randomness: {e}"))?;
    encrypt_with(&SecretKey::generate(), &salt, ua_public, auth, plaintext)
}

/// [`encrypt`] with a given sender key and salt (the RFC's test vector fixes both).
pub fn encrypt_with(as_secret: &SecretKey, salt: &[u8; 16], ua_public: &[u8], auth: &[u8], plaintext: &[u8]) -> anyhow::Result<Vec<u8>> {
    let ua = PublicKey::from_sec1_bytes(ua_public).context("bad p256dh key")?;
    let as_public = as_secret.public_key().to_sec1_bytes();
    let shared = diffie_hellman(as_secret.to_nonzero_scalar(), ua.as_affine());
    let (cek, nonce) = keys(shared.raw_secret_bytes(), auth, salt, ua_public, &as_public)?;
    // One record: the message, then the last-record delimiter (no further padding).
    let mut record = plaintext.to_vec();
    record.push(2);
    let cipher = Aes128Gcm::new_from_slice(&cek).map_err(|_| anyhow!("bad key"))?;
    let ciphertext = cipher.encrypt(&Nonce::from(nonce), record.as_slice()).map_err(|_| anyhow!("encryption failed"))?;
    let mut out = Vec::with_capacity(HEADER + ciphertext.len());
    out.extend_from_slice(salt);
    out.extend_from_slice(&RS.to_be_bytes());
    out.push(as_public.len() as u8);
    out.extend_from_slice(&as_public);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// The phone's side (for tests and the end-to-end check's fake push service).
pub fn decrypt(ua_secret: &SecretKey, auth: &[u8], body: &[u8]) -> anyhow::Result<Vec<u8>> {
    if body.len() < 21 {
        bail!("too short");
    }
    let salt: [u8; 16] = body[..16].try_into()?;
    let idlen = body[20] as usize;
    let (as_public, ciphertext) = body.get(21..).and_then(|rest| (rest.len() >= idlen).then(|| rest.split_at(idlen))).context("truncated header")?;
    let sender = PublicKey::from_sec1_bytes(as_public).context("bad sender key")?;
    let ua_public = ua_secret.public_key().to_sec1_bytes();
    let shared = diffie_hellman(ua_secret.to_nonzero_scalar(), sender.as_affine());
    let (cek, nonce) = keys(shared.raw_secret_bytes(), auth, &salt, &ua_public, as_public)?;
    let cipher = Aes128Gcm::new_from_slice(&cek).map_err(|_| anyhow!("bad key"))?;
    let mut record = cipher.decrypt(&Nonce::from(nonce), ciphertext).map_err(|_| anyhow!("decryption failed"))?;
    // Strip the padding: zeros, then the delimiter (2 for the last record).
    while record.last() == Some(&0) {
        record.pop();
    }
    if record.pop() != Some(2) {
        bail!("not a single final record");
    }
    Ok(record)
}

/// The content-encryption key and nonce (RFC 8291 §3.4, RFC 8188 §2.2).
fn keys(ecdh: &[u8], auth: &[u8], salt: &[u8; 16], ua_public: &[u8], as_public: &[u8]) -> anyhow::Result<([u8; 16], [u8; 12])> {
    let info = [b"WebPush: info\0".as_slice(), ua_public, as_public].concat();
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(auth), ecdh).expand(&info, &mut ikm).map_err(|_| anyhow!("hkdf"))?;
    let hk = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let (mut cek, mut nonce) = ([0u8; 16], [0u8; 12]);
    hk.expand(b"Content-Encoding: aes128gcm\0", &mut cek).map_err(|_| anyhow!("hkdf"))?;
    hk.expand(b"Content-Encoding: nonce\0", &mut nonce).map_err(|_| anyhow!("hkdf"))?;
    Ok((cek, nonce))
}

#[cfg(test)]
mod tests {
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    use super::*;

    fn b64(s: &str) -> Vec<u8> {
        URL_SAFE_NO_PAD.decode(s).unwrap()
    }

    /// RFC 8291 §5, verbatim.
    #[test]
    fn rfc8291_example() {
        let auth = b64("BTBZMqHH6r4Tts7J_aSIgg");
        let ua_secret = SecretKey::from_slice(&b64("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94")).unwrap();
        let ua_public = b64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
        let as_secret = SecretKey::from_slice(&b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")).unwrap();
        let body = b64(concat!(
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml",
            "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT",
            "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
        ));
        let plaintext = b"When I grow up, I want to be a watermelon";
        assert_eq!(ua_secret.public_key().to_sec1_bytes().as_ref(), ua_public.as_slice());

        let salt: [u8; 16] = body[..16].try_into().unwrap();
        let ours = encrypt_with(&as_secret, &salt, &ua_public, &auth, plaintext).unwrap();
        assert_eq!(ours, body, "byte-for-byte the RFC's message");
        assert_eq!(decrypt(&ua_secret, &auth, &body).unwrap(), plaintext);
    }

    #[test]
    fn round_trip_with_fresh_keys() {
        let phone = SecretKey::generate();
        let auth = [7u8; 16];
        let msg = br#"{"title":"refactor is done","body":"Finished"}"#;
        let body = encrypt(&phone.public_key().to_sec1_bytes(), &auth, msg).unwrap();
        assert_eq!(body.len(), HEADER + msg.len() + 1 + 16, "header, message, delimiter, tag");
        assert_eq!(decrypt(&phone, &auth, &body).unwrap(), msg);
        // Another phone can't read it.
        assert!(decrypt(&SecretKey::generate(), &auth, &body).is_err());
        // Nor with the wrong auth secret.
        assert!(decrypt(&phone, &[8u8; 16], &body).is_err());
    }
}
