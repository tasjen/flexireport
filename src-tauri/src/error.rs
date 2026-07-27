/// Every failure a Tauri command can return.
///
/// The `Display` text is what the user reads: commands serialize as a plain
/// string, and the frontend renders `String(reason)` straight into the UI.
/// Keep every variant's message fit for that, and keep the wrapping variants
/// `transparent` so an underlying cause is never replaced by a vaguer one.
#[derive(thiserror::Error, Debug)]
pub(crate) enum AppError {
    #[error("{0}")]
    Msg(String),
    #[error("The {0} browser is busy; wait for the current browser action to finish")]
    BrowserBusy(&'static str),
    // `CdpError` is large; box it so `Result<_, AppError>` stays small.
    #[error(transparent)]
    Cdp(Box<chromiumoxide::error::CdpError>),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Store(#[from] tauri_plugin_store::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
}

// Manual `From` (rather than `#[from]`) so `?` boxes the error at the call site
// and the variant can stay boxed.
impl From<chromiumoxide::error::CdpError> for AppError {
    fn from(e: chromiumoxide::error::CdpError) -> Self {
        AppError::Cdp(Box::new(e))
    }
}

impl From<String> for AppError {
    fn from(s: String) -> Self {
        AppError::Msg(s)
    }
}

impl From<&str> for AppError {
    fn from(s: &str) -> Self {
        AppError::Msg(s.to_string())
    }
}

// Tauri command errors must be `Serialize`; serialize as the `Display` string.
impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::AppError;

    #[test]
    fn owned_and_borrowed_messages_display_unchanged() {
        let owned = AppError::from("Portal URL not configured".to_string());
        let borrowed = AppError::from("Phone number not configured");

        assert_eq!(
            (owned.to_string(), borrowed.to_string()),
            (
                "Portal URL not configured".to_string(),
                "Phone number not configured".to_string()
            )
        );
    }

    #[test]
    fn a_command_error_serializes_to_the_message_it_displays() {
        // The frontend has no error shape to destructure — `account-form.tsx`
        // renders `String(reason)`. Serializing as anything but a bare string
        // would put `[object Object]` in the dialog.
        let error = AppError::from("Wrong phone number");

        let serialized = serde_json::to_value(&error).unwrap();

        assert_eq!(
            serialized,
            serde_json::Value::String(error.to_string()),
            "command errors must serialize as their display text"
        );
    }

    #[test]
    fn a_busy_browser_error_is_ready_for_the_frontend() {
        let error = AppError::BrowserBusy("headed");

        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            serde_json::Value::String(
                "The headed browser is busy; wait for the current browser action to finish".into()
            )
        );
    }

    #[test]
    fn wrapped_causes_keep_their_own_message() {
        // Every wrapping variant is `#[error(transparent)]`, so `?` never
        // replaces a specific cause with a vaguer wrapper.
        let io: AppError =
            std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied").into();
        let json: AppError = serde_json::from_str::<u8>("nope").unwrap_err().into();

        assert_eq!(io.to_string(), "denied");
        assert!(
            json.to_string().contains("expected"),
            "serde's own message should survive, got: {json}"
        );
    }

    #[test]
    fn context_added_to_an_error_reaches_the_user_verbatim() {
        // The pattern used by login and submission confirmation: keep the
        // original message and append the explanation on its own line.
        let cause = AppError::from("Timed out waiting for URL: https://portal.example.com");

        let wrapped = AppError::from(format!("{cause}\nThe portal didn't confirm the submission"));

        assert_eq!(
            serde_json::to_value(&wrapped).unwrap(),
            serde_json::Value::String(
                "Timed out waiting for URL: https://portal.example.com\nThe portal didn't confirm the submission"
                    .into()
            )
        );
    }
}
