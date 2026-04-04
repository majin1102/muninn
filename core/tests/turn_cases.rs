use std::collections::BTreeSet;

use lance::{Error, Result};
use muninn_sidecar::llm::turn::TurnGenerator;
use muninn_sidecar::llm::turn_eval::{TurnCase, TurnCaseEvaluation, evaluate_turn_output};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct TurnCasesFile {
    cases: Vec<TurnCase>,
}

fn load_turn_cases() -> Result<Vec<TurnCase>> {
    serde_yaml::from_str::<TurnCasesFile>(include_str!("fixtures/turn_cases.yaml"))
        .map(|parsed| parsed.cases)
        .map_err(|error| Error::invalid_input(format!("invalid turn_cases.yaml: {error}")))
}

async fn evaluate_configured_turn_cases() -> Result<Vec<TurnCaseEvaluation>> {
    let mut evaluations = Vec::new();
    for case in load_turn_cases()? {
        let generated =
            TurnGenerator::generate_if_configured(Some(case.prompt.as_str()), &case.response)
                .await?
                .ok_or_else(|| Error::invalid_input("turn provider is not configured"))?;
        let evaluation = evaluate_turn_output(Some(&case.prompt), &case.response, &generated);
        evaluations.push(TurnCaseEvaluation {
            name: case.name,
            title: generated.title,
            summary: generated.summary,
            evaluation,
        });
    }
    Ok(evaluations)
}

#[test]
fn turn_fixtures_are_non_empty_and_named_uniquely() {
    let cases = load_turn_cases().expect("turn_cases.yaml must be valid");
    let mut names = BTreeSet::new();
    assert!(cases.len() >= 3, "expected multiple turn fixture cases");
    for case in cases {
        assert!(
            names.insert(case.name.clone()),
            "duplicate case name: {}",
            case.name
        );
        assert!(
            !case.prompt.trim().is_empty(),
            "prompt must not be empty: {}",
            case.name
        );
        assert!(
            !case.response.trim().is_empty(),
            "response must not be empty: {}",
            case.name
        );
    }
}

#[test]
fn turn_cases_fixture_loads_multiple_cases() {
    let cases = load_turn_cases().expect("fixture cases should load");
    assert!(cases.len() >= 3);
    assert!(cases.iter().any(|item| item.name == "preference_capture"));
}

#[tokio::test]
#[ignore = "live provider validation against configured turn model"]
async fn turn_with_configured_provider() {
    let case = load_turn_cases()
        .expect("turn_cases.yaml must be valid")
        .into_iter()
        .find(|item| item.name == "observing_debugging_review")
        .expect("fixture case observing_debugging_review must exist");

    let generated =
        TurnGenerator::generate_if_configured(Some(case.prompt.as_str()), &case.response)
            .await
            .expect("live provider call should succeed")
            .expect("configured provider should return a turn");

    println!("LIVE TURN INPUT PROMPT:\n{}\n", case.prompt);
    println!("LIVE TURN INPUT RESPONSE:\n{}\n", case.response);
    println!("LIVE TURN OUTPUT TITLE:\n{}\n", generated.title);
    println!("LIVE TURN OUTPUT SUMMARY:\n{}\n", generated.summary);

    assert!(!generated.title.trim().is_empty());
    assert!(!generated.summary.trim().is_empty());
    assert!(!generated.title.contains('\n'));
    assert!(!generated.summary.contains('\n'));
    assert!(generated.title.len() <= 100);
    assert!(generated.summary.len() <= 1200);
}

#[tokio::test]
#[ignore = "live provider evaluation across configured turn cases"]
async fn configured_turn_cases_can_be_scored() {
    let evaluations = evaluate_configured_turn_cases()
        .await
        .expect("configured provider should evaluate all turn cases");

    assert!(!evaluations.is_empty());
    for item in evaluations {
        println!(
            "CASE={} SCORE={} PASSED={}\nTITLE={}\nSUMMARY={}\nISSUES={:?}\n",
            item.name,
            item.evaluation.score,
            item.evaluation.passed,
            item.title,
            item.summary,
            item.evaluation.issues
        );
        assert!(!item.title.trim().is_empty());
        assert!(!item.summary.trim().is_empty());
    }
}
