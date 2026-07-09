#!/usr/bin/env python3
"""MTurk requester utilities for the VR helper MTurk study.

Examples:
  python scripts/mturk_assignments.py list --hit-id HIT_ID --sandbox
  python scripts/mturk_assignments.py validate --hit-id HIT_ID --sandbox --backend-url https://your-backend.onrender.com
  python scripts/mturk_assignments.py approve --hit-id HIT_ID --sandbox --backend-url https://your-backend.onrender.com --dry-run
  python scripts/mturk_assignments.py approve --hit-id HIT_ID --sandbox --backend-url https://your-backend.onrender.com --approve
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

try:
    import boto3
except ImportError:  # pragma: no cover
    boto3 = None

SANDBOX_ENDPOINT = "https://mturk-requester-sandbox.us-east-1.amazonaws.com"
PRODUCTION_ENDPOINT = "https://mturk-requester.us-east-1.amazonaws.com"


def fail(message: str, code: int = 1) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(code)


def make_client(args):
    if boto3 is None:
        fail("boto3 is not installed. Run: pip install boto3")
    kwargs = {
        "region_name": args.region,
        "endpoint_url": SANDBOX_ENDPOINT if args.sandbox else PRODUCTION_ENDPOINT,
    }
    if args.profile:
        session = boto3.Session(profile_name=args.profile)
        return session.client("mturk", **kwargs)
    return boto3.client("mturk", **kwargs)


def list_assignments(client, hit_id: str, statuses: list[str]):
    assignments = []
    paginator = client.get_paginator("list_assignments_for_hit")
    for page in paginator.paginate(
        HITId=hit_id,
        AssignmentStatuses=statuses,
        PaginationConfig={"PageSize": 100},
    ):
        assignments.extend(page.get("Assignments", []))
    return assignments


def parse_answer_xml(answer_xml: str) -> dict[str, str]:
    values: dict[str, str] = {}
    if not answer_xml:
        return values
    try:
        root = ET.fromstring(answer_xml)
    except ET.ParseError:
        return values
    for answer in root.findall(".//{*}Answer"):
        qid = answer.find("{*}QuestionIdentifier")
        free_text = answer.find("{*}FreeText")
        if qid is not None and free_text is not None:
            values[qid.text or ""] = free_text.text or ""
    return values


def get_assignment_row(assignment: dict) -> dict:
    answers = parse_answer_xml(assignment.get("Answer", ""))
    return {
        "assignment_id": assignment.get("AssignmentId", ""),
        "worker_id": assignment.get("WorkerId", ""),
        "hit_id": assignment.get("HITId", ""),
        "status": assignment.get("AssignmentStatus", ""),
        "completion_code": answers.get("completion_code", ""),
        "session_id": answers.get("session_id", ""),
        "study_worker_id": answers.get("study_worker_id", ""),
        "study_hit_id": answers.get("study_hit_id", ""),
        "raw_answers": answers,
    }


def load_backend_sessions(backend_url: str) -> list[dict]:
    if not backend_url:
        return []
    url = backend_url.rstrip("/") + "/api/sessions"
    with urllib.request.urlopen(url, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return payload.get("sessions", [])


def load_local_sessions(data_dir: str) -> list[dict]:
    if not data_dir:
        return []
    sessions = []
    for file_path in Path(data_dir).glob("*.json"):
        try:
            session = json.loads(file_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        params = session.get("participant_params", {})
        sessions.append({
            "filename": file_path.name,
            "session_id": session.get("session_id", ""),
            "workerId": session.get("workerId") or params.get("workerId", ""),
            "assignmentId": session.get("assignmentId") or params.get("assignmentId", ""),
            "hitId": session.get("hitId") or params.get("hitId", ""),
            "completion_status": session.get("completion_status", ""),
            "attention_passed": session.get("attention_passed", ""),
            "completion_code": session.get("completion_code", ""),
        })
    return sessions


def index_sessions(sessions: list[dict]) -> dict[tuple[str, str], dict]:
    index = {}
    for session in sessions:
        code = str(session.get("completion_code", "")).strip().upper()
        assignment_id = str(session.get("assignmentId", "")).strip()
        if code and assignment_id:
            index[(assignment_id, code)] = session
    return index


def validate_rows(assignments: list[dict], sessions: list[dict]) -> list[dict]:
    session_index = index_sessions(sessions)
    rows = []
    for assignment in assignments:
      row = get_assignment_row(assignment)
      code = row["completion_code"].strip().upper()
      match = session_index.get((row["assignment_id"], code))
      valid = bool(
          match
          and match.get("completion_status") == "completed"
          and match.get("attention_passed") is True
          and match.get("workerId") == row["worker_id"]
          and match.get("hitId") == row["hit_id"]
      )
      row.update({
          "valid": valid,
          "matched_session_id": match.get("session_id", "") if match else "",
          "matched_file": match.get("filename", "") if match else "",
          "reason": "valid" if valid else "missing or mismatched saved session/code",
      })
      rows.append(row)
    return rows


def print_rows(rows: list[dict]) -> None:
    for row in rows:
        print(json.dumps(row, indent=2, default=str))


def main() -> None:
    parser = argparse.ArgumentParser(description="List, validate, and approve VR helper MTurk assignments.")
    parser.add_argument("command", choices=["list", "validate", "approve"])
    parser.add_argument("--hit-id", required=True)
    parser.add_argument("--sandbox", action="store_true")
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--profile", default="")
    parser.add_argument("--backend-url", default="", help="Metrics backend base URL, e.g. https://...onrender.com")
    parser.add_argument("--data-dir", default="", help="Local data/sessions folder if validating local files")
    parser.add_argument("--statuses", nargs="+", default=["Submitted"], choices=["Submitted", "Approved", "Rejected"])
    parser.add_argument("--approve", action="store_true", help="Actually approve valid assignments. Without this, approve is dry-run.")
    args = parser.parse_args()

    client = make_client(args)
    assignments = list_assignments(client, args.hit_id, args.statuses)

    if args.command == "list":
        print_rows([get_assignment_row(assignment) for assignment in assignments])
        return

    sessions = load_backend_sessions(args.backend_url) if args.backend_url else load_local_sessions(args.data_dir)
    if not sessions:
        fail("No saved study sessions found. Provide --backend-url or --data-dir.")
    rows = validate_rows(assignments, sessions)

    if args.command == "validate":
        print_rows(rows)
        return

    approved = []
    skipped = []
    for row in rows:
        if not row["valid"]:
            skipped.append(row)
            continue
        if args.approve:
            client.approve_assignment(
                AssignmentId=row["assignment_id"],
                RequesterFeedback="Completion code matched saved study session.",
                OverrideRejection=False,
            )
        approved.append(row)

    print(json.dumps({
        "dry_run": not args.approve,
        "approved_count": len(approved),
        "skipped_count": len(skipped),
        "approved": approved,
        "skipped": skipped,
    }, indent=2, default=str))


if __name__ == "__main__":
    main()
