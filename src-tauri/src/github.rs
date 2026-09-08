use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::Result;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub url: String,
    pub owner: String,
    pub repo: String,
    /// issue | pull
    pub kind: String,
    pub number: i64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    pub reference: Option<Reference>,
    pub title: Option<String>,
    pub body: Option<String>,
    /// For a pull request: the branch to check out rather than create.
    pub branch: Option<String>,
}

/// Accepts what people actually paste: a full URL, with or without a scheme,
/// query string or trailing slash.
pub fn parse(input: &str) -> Option<Reference> {
    let trimmed = input.trim();
    let rest = trimmed
        .split_once("github.com/")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    // Query and fragment first, then the trailing slash they were hiding.
    let rest = rest.split(['?', '#']).next().unwrap_or(rest).trim_end_matches('/');

    let parts: Vec<&str> = rest.split('/').collect();
    let [owner, repo, section, number] = parts.as_slice() else {
        return None;
    };

    let kind = match *section {
        "issues" => "issue",
        "pull" | "pulls" => "pull",
        _ => return None,
    };
    let number: i64 = number.parse().ok()?;
    if owner.is_empty() || repo.is_empty() {
        return None;
    }

    Some(Reference {
        url: format!("https://github.com/{owner}/{repo}/{section}/{number}"),
        owner: owner.to_string(),
        repo: repo.to_string(),
        kind: kind.to_string(),
        number,
    })
}

/// Fills in the title, body and (for a pull request) the head branch using the
/// `gh` CLI. Without `gh` the card still gets its number and URL — the lookup is
/// an enrichment, never a requirement.
pub fn resolve(input: &str) -> Result<Resolved> {
    let Some(reference) = parse(input) else {
        return Ok(Resolved::default());
    };

    let repo = format!("{}/{}", reference.owner, reference.repo);
    let number = reference.number.to_string();
    let fields = if reference.kind == "pull" {
        "title,body,headRefName"
    } else {
        "title,body"
    };
    let subcommand = if reference.kind == "pull" { "pr" } else { "issue" };

    let mut command = Command::new("gh");
    command.args([subcommand, "view", &number, "--repo", &repo, "--json", fields]);

    let looked_up = crate::process::run(command, Duration::from_secs(20))
        .ok()
        .filter(|output| output.ok)
        .and_then(|output| serde_json::from_str::<serde_json::Value>(&output.stdout).ok());

    let field = |name: &str| -> Option<String> {
        looked_up
            .as_ref()?
            .get(name)?
            .as_str()
            .map(str::to_string)
            .filter(|value| !value.is_empty())
    };

    Ok(Resolved {
        title: field("title"),
        body: field("body"),
        branch: field("headRefName"),
        reference: Some(reference),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_the_urls_people_paste() {
        let issue = parse("https://github.com/anthropics/claude-code/issues/42").unwrap();
        assert_eq!((issue.kind.as_str(), issue.number), ("issue", 42));
        assert_eq!(issue.repo, "claude-code");

        let pull = parse("github.com/owner/repo/pull/7/?utm=x").unwrap();
        assert_eq!((pull.kind.as_str(), pull.number), ("pull", 7));
        assert_eq!(pull.url, "https://github.com/owner/repo/pull/7");

        assert_eq!(parse("owner/repo/issues/9").unwrap().owner, "owner");
    }

    #[test]
    fn plain_text_is_not_a_reference() {
        for input in ["Fix the flaky test", "https://github.com/owner/repo", ""] {
            assert!(parse(input).is_none(), "{input:?} should not parse");
        }
    }
}
