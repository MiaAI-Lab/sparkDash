//! Client for sparkDash's `/api/clipboard` routes (docs/CLIPBOARD.md).

use std::fmt;
use std::time::Duration;

use serde::Deserialize;
use ureq::Agent;

/// Largest body read back: one part or text can't exceed the server's own limits.
const MAX_BODY: u64 = 64 * 1024 * 1024;

#[derive(Debug)]
pub enum ApiError {
    /// 404: the dashboard has the shared clipboard turned off.
    Off,
    /// 401/403: missing or wrong token, or a bind that refuses the clipboard.
    Refused(String),
    TooLarge(String),
    Http(u16, String),
    Net(String),
    Io(String),
    Protocol(String),
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ApiError::Off => write!(f, "the dashboard's shared clipboard is off"),
            ApiError::Refused(m) => write!(f, "the dashboard refused the request: {m}"),
            ApiError::TooLarge(m) => write!(f, "{m}"),
            ApiError::Http(s, m) => write!(f, "HTTP {s}: {m}"),
            ApiError::Net(m) | ApiError::Io(m) | ApiError::Protocol(m) => write!(f, "{m}"),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Part {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Source {
    pub device: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub content_key: String,
    pub parts: Vec<Part>,
    pub source: Source,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub max_text_bytes: u64,
    pub max_part_bytes: u64,
    pub max_parts: u64,
    pub max_entry_bytes: u64,
}

#[derive(Deserialize)]
struct State {
    revision: i64,
    latest: Option<Entry>,
    #[serde(default)]
    limits: Option<Limits>,
}

#[derive(Deserialize)]
struct Created {
    entry: Entry,
}

#[derive(Deserialize)]
struct UploadId {
    id: String,
}

#[derive(Deserialize)]
struct Uploaded {
    upload: UploadId,
}

#[derive(Deserialize)]
struct ErrorBody {
    error: String,
}

#[derive(Clone)]
pub struct Api {
    base: String,
    auth: Option<String>,
    device: String,
    agent: Agent,
}

impl Api {
    pub fn new(dashboard: &str, token: Option<String>, device: &str) -> Self {
        let agent: Agent = Agent::config_builder()
            .http_status_as_error(false)
            .timeout_connect(Some(Duration::from_secs(10)))
            .timeout_global(Some(Duration::from_secs(120)))
            .user_agent(concat!("sparkdash-agent/", env!("CARGO_PKG_VERSION")))
            .build()
            .into();
        Api {
            base: format!("{dashboard}/api/clipboard"),
            auth: token.map(|t| format!("Bearer {t}")),
            device: device.to_string(),
            agent,
        }
    }

    fn get(&self, path: &str) -> ureq::RequestBuilder<ureq::typestate::WithoutBody> {
        let req = self.agent.get(format!("{}{path}", self.base));
        match &self.auth {
            Some(a) => req.header("Authorization", a),
            None => req,
        }
    }

    fn post(
        &self,
        path: &str,
        content_type: &str,
    ) -> ureq::RequestBuilder<ureq::typestate::WithBody> {
        let req = self
            .agent
            .post(format!("{}{path}", self.base))
            .header("Content-Type", content_type)
            .header("X-Clipboard-Device", &self.device);
        match &self.auth {
            Some(a) => req.header("Authorization", a),
            None => req,
        }
    }

    pub fn limits(&self) -> Result<Limits, ApiError> {
        let state: State = json(self.get("").call())?;
        state
            .limits
            .ok_or(ApiError::Protocol("no limits in the answer".into()))
    }

    /// `(revision, latest)`; waits up to `wait` for a change when `since` is current.
    pub fn changes(
        &self,
        since: Option<i64>,
        wait: Duration,
    ) -> Result<(i64, Option<Entry>), ApiError> {
        let path = match since {
            Some(rev) => format!("/changes?since={rev}&timeoutMs={}", wait.as_millis()),
            None => "/changes?since=-1".to_string(),
        };
        let state: State = json(self.get(&path).call())?;
        Ok((state.revision, state.latest))
    }

    pub fn text(&self, id: &str) -> Result<String, ApiError> {
        String::from_utf8(bytes(self.get(&format!("/{id}/text")).call())?)
            .map_err(|_| ApiError::Protocol("text is not UTF-8".into()))
    }

    pub fn part(&self, id: &str, part: &str) -> Result<Vec<u8>, ApiError> {
        bytes(self.get(&format!("/{id}/parts/{part}?download=1")).call())
    }

    pub fn post_text(&self, text: &str) -> Result<Entry, ApiError> {
        let created: Created = json(self.post("/text", "text/plain; charset=utf-8").send(text))?;
        Ok(created.entry)
    }

    pub fn upload(&self, name: &str, mime: &str, body: Vec<u8>) -> Result<String, ApiError> {
        let req = self
            .post("/uploads", mime)
            .header("X-Clipboard-Name", encode_name(name));
        let up: Uploaded = json(req.send(&body[..]))?;
        Ok(up.upload.id)
    }

    pub fn commit(&self, uploads: &[String], kind: &str) -> Result<Entry, ApiError> {
        let body = serde_json::json!({ "uploads": uploads, "type": kind }).to_string();
        let created: Created = json(self.post("", "application/json").send(&body))?;
        Ok(created.entry)
    }
}

/// Percent-encodes everything but unreserved characters, like encodeURIComponent.
fn encode_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for b in name.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn checked(
    res: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
) -> Result<ureq::http::Response<ureq::Body>, ApiError> {
    let mut res = res.map_err(|e| ApiError::Net(e.to_string()))?;
    let status = res.status().as_u16();
    if (200..300).contains(&status) {
        return Ok(res);
    }
    let message = res
        .body_mut()
        .with_config()
        .limit(64 * 1024)
        .read_to_string()
        .ok()
        .and_then(|s| serde_json::from_str::<ErrorBody>(&s).ok())
        .map(|b| b.error)
        .unwrap_or_default();
    Err(match status {
        404 => ApiError::Off,
        401 | 403 => ApiError::Refused(message),
        413 => ApiError::TooLarge(message),
        _ => ApiError::Http(status, message),
    })
}

fn bytes(res: Result<ureq::http::Response<ureq::Body>, ureq::Error>) -> Result<Vec<u8>, ApiError> {
    checked(res)?
        .body_mut()
        .with_config()
        .limit(MAX_BODY)
        .read_to_vec()
        .map_err(|e| ApiError::Net(e.to_string()))
}

fn json<T: for<'de> Deserialize<'de>>(
    res: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
) -> Result<T, ApiError> {
    serde_json::from_slice(&bytes(res)?).map_err(|e| ApiError::Protocol(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_encoded_like_encode_uri_component() {
        assert_eq!(encode_name("report final.pdf"), "report%20final.pdf");
        assert_eq!(encode_name("ü/x"), "%C3%BC%2Fx");
    }

    #[test]
    fn reads_the_entry_contract() {
        let s = r#"{"revision":3,"latest":{"id":"a","type":"image","textSize":0,"textPreview":null,"textTruncated":false,
            "parts":[{"id":"p","name":"x.png","mimeType":"image/png","size":1,"sha256":"00"}],"size":1,"contentKey":"k",
            "source":{"kind":"device","device":"desk"},"createdAt":1},"limits":{"maxEntries":10,"maxTextBytes":1,
            "maxPartBytes":2,"maxParts":3,"maxEntryBytes":4}}"#;
        let state: State = serde_json::from_str(s).unwrap();
        let e = state.latest.unwrap();
        assert_eq!(
            (state.revision, e.kind.as_str(), e.content_key.as_str()),
            (3, "image", "k")
        );
        assert_eq!(e.source.device.as_deref(), Some("desk"));
        assert_eq!(state.limits.unwrap().max_entry_bytes, 4);
    }
}
