#!/usr/bin/env python3
"""View MTurk HITs and submissions in sandbox or production."""

from __future__ import annotations

import argparse
import json
import xml.etree.ElementTree as ET

import boto3

from mturk_config import ENVIRONMENTS, STUDY


def make_client(environment_name: str):
    environment = ENVIRONMENTS[environment_name]
    kwargs = {
        "region_name": STUDY.aws_region,
        "endpoint_url": environment.endpoint_url,
    }
    if STUDY.aws_profile:
        return boto3.Session(profile_name=STUDY.aws_profile).client("mturk", **kwargs)
    return boto3.client("mturk", **kwargs)


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


def list_recent_hits(client, max_hits: int) -> list[dict]:
    hits = []
    paginator = client.get_paginator("list_hits")
    for page in paginator.paginate(PaginationConfig={"PageSize": 100}):
        hits.extend(page.get("HITs", []))
        if len(hits) >= max_hits:
            break
    return hits[:max_hits]


def list_assignments(client, hit_id: str, statuses: list[str]) -> list[dict]:
    assignments = []
    paginator = client.get_paginator("list_assignments_for_hit")
    for page in paginator.paginate(
        HITId=hit_id,
        AssignmentStatuses=statuses,
        PaginationConfig={"PageSize": 100},
    ):
        assignments.extend(page.get("Assignments", []))
    return assignments


def assignment_row(assignment: dict) -> dict:
    answers = parse_answer_xml(assignment.get("Answer", ""))
    return {
        "hit_id": assignment.get("HITId", ""),
        "assignment_id": assignment.get("AssignmentId", ""),
        "worker_id": assignment.get("WorkerId", ""),
        "status": assignment.get("AssignmentStatus", ""),
        "accept_time": str(assignment.get("AcceptTime", "")),
        "submit_time": str(assignment.get("SubmitTime", "")),
        "completion_code": answers.get("completion_code", ""),
        "session_id": answers.get("session_id", ""),
        "study_worker_id": answers.get("study_worker_id", ""),
        "study_hit_id": answers.get("study_hit_id", ""),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="View VR helper MTurk submissions.")
    parser.add_argument("--environment", choices=["sandbox", "production"], default="sandbox")
    parser.add_argument("--hit-id", default="", help="If omitted, shows recent HITs.")
    parser.add_argument("--max-hits", type=int, default=20)
    parser.add_argument("--statuses", nargs="+", default=["Submitted", "Approved", "Rejected"])
    args = parser.parse_args()

    client = make_client(args.environment)

    if not args.hit_id:
        rows = [
            {
                "hit_id": hit.get("HITId", ""),
                "title": hit.get("Title", ""),
                "status": hit.get("HITStatus", ""),
                "created": str(hit.get("CreationTime", "")),
                "available": hit.get("NumberOfAssignmentsAvailable", 0),
                "pending": hit.get("NumberOfAssignmentsPending", 0),
                "completed": hit.get("NumberOfAssignmentsCompleted", 0),
            }
            for hit in list_recent_hits(client, args.max_hits)
        ]
        print(json.dumps(rows, indent=2))
        return

    assignments = list_assignments(client, args.hit_id, args.statuses)
    print(json.dumps([assignment_row(assignment) for assignment in assignments], indent=2))


if __name__ == "__main__":
    main()

