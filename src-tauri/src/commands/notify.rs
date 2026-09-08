use serde::Deserialize;
use std::time::Duration;

use crate::error::{Error, Result};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookTarget {
    pub name: String,
    pub url: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookResult {
    pub name: String,
    pub ok: bool,
    pub message: Option<String>,
}

/// Posts a Google Chat / Workspace incoming-webhook message. One failing target
/// must not silence the others, so every result comes back and the caller
/// decides what to show.
#[tauri::command]
pub fn post_webhooks(targets: Vec<WebhookTarget>, text: String) -> Vec<WebhookResult> {
    targets
        .into_iter()
        .map(|target| match post(&target.url, &text) {
            Ok(()) => WebhookResult {
                name: target.name,
                ok: true,
                message: None,
            },
            Err(error) => WebhookResult {
                name: target.name,
                ok: false,
                message: Some(error.to_string()),
            },
        })
        .collect()
}

fn post(url: &str, text: &str) -> Result<()> {
    // Only the Workspace webhook host, so a stray settings row cannot turn the
    // app into a general-purpose request sender.
    if !url.starts_with("https://chat.googleapis.com/") {
        return Err(Error::Invalid(
            "a webhook URL must start with https://chat.googleapis.com/".into(),
        ));
    }

    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(10)))
        .build()
        .into();

    agent
        .post(url)
        .content_type("application/json")
        .send_json(serde_json::json!({ "text": text }))
        .map_err(|e| Error::Invalid(format!("{e}")))?;
    Ok(())
}
