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
    let pull = reference.kind == "pull";
    let subcommand = if pull { "pr" } else { "issue" };

    let view = |fields: &str| -> Option<serde_json::Value> {
        let mut command = crate::platform::command("gh");
        command.args([subcommand, "view", &number, "--repo", &repo, "--json", fields]);
        crate::process::run(command, Duration::from_secs(20))
            .ok()
            .filter(|output| output.ok)
            .and_then(|output| serde_json::from_str(&output.stdout).ok())
    };

    let looked_up = if pull {
        view("title,body,headRefName")
    } else {
        // `issueType` only exists in newer `gh`, and asking an older one for it
        // fails the whole call — so the retry still gets the title and body.
        view("title,body,labels,issueType").or_else(|| view("title,body,labels"))
    };

    let field = |name: &str| -> Option<String> {
        looked_up
            .as_ref()?
            .get(name)?
            .as_str()
            .map(str::to_string)
            .filter(|value| !value.is_empty())
    };

    // A pull request has a branch already; an issue gets one named after what it
    // is and its number, which is the part of an issue that never changes.
    let branch = if pull {
        field("headRefName")
    } else {
        let labels = looked_up
            .as_ref()
            .and_then(|found| found.get("labels")?.as_array().cloned())
            .unwrap_or_default();
        let names: Vec<String> = labels
            .iter()
            .filter_map(|label| Some(label.get("name")?.as_str()?.to_string()))
            .collect();
        let issue_type = looked_up
            .as_ref()
            .and_then(|found| found.get("issueType")?.get("name")?.as_str())
            .map(str::to_string);

        Some(format!(
            "{}-{}",
            issue_kind(issue_type.as_deref(), &names),
            reference.number
        ))
    };

    Ok(Resolved {
        title: field("title"),
        body: field("body"),
        branch,
        reference: Some(reference),
    })
}

/// Which of the three kinds of work an issue is.
///
/// A repo that uses GitHub's native issue types has said so outright; one that
/// does not has said it in a label instead. Anything unrecognised is a task,
/// which is what most issues are.
fn issue_kind(issue_type: Option<&str>, labels: &[String]) -> &'static str {
    let classify = |value: &str| -> Option<&'static str> {
        let value = value.to_ascii_lowercase();
        if value.contains("bug") || value.contains("defect") {
            Some("bug")
        } else if value.contains("feature") || value.contains("enhancement") {
            Some("feature")
        } else {
            None
        }
    };

    issue_type
        .and_then(classify)
        .or_else(|| labels.iter().find_map(|label| classify(label)))
        .unwrap_or("task")
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
    fn an_issue_is_named_after_what_it_is() {
        let none: [String; 0] = [];

        // The native type is what a repo using them has said outright.
        assert_eq!(issue_kind(Some("Bug"), &none), "bug");
        assert_eq!(issue_kind(Some("Feature"), &none), "feature");
        assert_eq!(issue_kind(Some("Task"), &none), "task");

        // Otherwise its labels are what it actually has.
        assert_eq!(issue_kind(None, &["needs-triage".into(), "bug".into()]), "bug");
        assert_eq!(issue_kind(None, &["enhancement".into()]), "feature");

        // A type the repo does use wins over a label that disagrees.
        assert_eq!(issue_kind(Some("Bug"), &["enhancement".into()]), "bug");

        // Anything unrecognised is a task, which is what most issues are.
        assert_eq!(issue_kind(None, &none), "task");
        assert_eq!(issue_kind(Some("Epic"), &["question".into()]), "task");
    }

    #[test]
    fn plain_text_is_not_a_reference() {
        for input in ["Fix the flaky test", "https://github.com/owner/repo", ""] {
            assert!(parse(input).is_none(), "{input:?} should not parse");
        }
    }
}
