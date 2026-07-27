use serde_json::Value;

use crate::AppError;

/// Decides which requests may receive the portal's Basic-auth credential.
///
/// Chromium request interception is the adapter in `lib.rs`; this module owns
/// the origin and header rules so they can be tested without a browser.
pub(crate) struct BasicAuthPolicy {
    origin: String,
    authorization: String,
}

impl BasicAuthPolicy {
    pub(crate) fn new(portal_url: &str, token: &str) -> Result<Self, AppError> {
        let portal_url = tauri::Url::parse(portal_url)
            .map_err(|error| AppError::from(format!("Invalid portal URL: {error}")))?;
        if !matches!(portal_url.scheme(), "http" | "https") {
            return Err("Portal URL must use HTTP or HTTPS".into());
        }
        Ok(Self {
            origin: portal_url.origin().ascii_serialization(),
            authorization: format!("Basic {token}"),
        })
    }

    pub(crate) fn url_pattern(&self) -> String {
        format!("{}/*", self.origin)
    }

    /// Returns the full replacement header list for an allowed request.
    /// `None` means the request is outside the portal origin and must continue
    /// untouched.
    pub(crate) fn headers_for(
        &self,
        request_url: &str,
        headers: &Value,
    ) -> Option<Vec<(String, String)>> {
        let request_origin = tauri::Url::parse(request_url)
            .ok()?
            .origin()
            .ascii_serialization();
        if request_origin != self.origin {
            return None;
        }

        let mut entries = headers
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(name, _)| !name.eq_ignore_ascii_case("authorization"))
            .map(|(name, value)| {
                (
                    name.clone(),
                    value
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| value.to_string()),
                )
            })
            .collect::<Vec<_>>();
        entries.push(("Authorization".into(), self.authorization.clone()));
        Some(entries)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::json;

    use super::BasicAuthPolicy;

    #[test]
    fn credentials_are_scoped_to_the_exact_canonical_origin() {
        let policy =
            BasicAuthPolicy::new("HTTPS://Portal.Example.com:443/team", "encoded").unwrap();
        let headers = json!({ "Accept": "text/html" });

        assert_eq!(policy.url_pattern(), "https://portal.example.com/*");
        assert!(policy
            .headers_for("https://portal.example.com/task.php", &headers)
            .is_some());
        for external in [
            "http://portal.example.com/task.php",
            "https://portal.example.com:444/task.php",
            "https://portal.example.com.evil/task.php",
        ] {
            assert!(
                policy.headers_for(external, &headers).is_none(),
                "{external} must not receive the portal credential"
            );
        }
    }

    #[test]
    fn same_origin_headers_are_preserved_and_existing_authorization_is_replaced() {
        let policy = BasicAuthPolicy::new("https://portal.example.com", "encoded").unwrap();

        let headers = policy
            .headers_for(
                "https://portal.example.com/member.php",
                &json!({
                    "Accept": "text/html",
                    "authorization": "Basic stale",
                    "X-Count": 2,
                }),
            )
            .unwrap()
            .into_iter()
            .collect::<HashMap<_, _>>();

        assert_eq!(
            headers,
            HashMap::from([
                ("Accept".into(), "text/html".into()),
                ("Authorization".into(), "Basic encoded".into()),
                ("X-Count".into(), "2".into()),
            ])
        );
    }

    #[test]
    fn malformed_request_urls_fail_closed_and_non_http_portals_are_rejected() {
        let policy = BasicAuthPolicy::new("https://portal.example.com", "encoded").unwrap();

        assert!(policy.headers_for("not a URL", &json!({})).is_none());
        assert!(BasicAuthPolicy::new("file:///tmp/portal", "encoded").is_err());
    }
}
