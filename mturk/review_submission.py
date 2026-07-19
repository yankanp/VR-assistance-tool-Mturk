#!/usr/bin/env python3
"""Approve or reject one MTurk assignment in sandbox or production."""

from __future__ import annotations

import argparse
import xml.etree.ElementTree as ET

import boto3

from mturk_config import ENVIRONMENTS, STUDY
from create_study import find_or_create_completed_qualification


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


def grant_completed_qualification(client, environment_name: str, worker_id: str) -> str:
    qualification_id = find_or_create_completed_qualification(client, environment_name)
    client.associate_qualification_with_worker(
        QualificationTypeId=qualification_id,
        WorkerId=worker_id,
        IntegerValue=1,
        SendNotification=False,
    )
    return qualification_id


def main() -> None:
    parser = argparse.ArgumentParser(description="Approve or reject one VR helper MTurk assignment.")
    parser.add_argument("--environment", choices=["sandbox", "production"], default="sandbox")
    parser.add_argument("--assignment-id", required=True)
    parser.add_argument("--action", choices=["approve", "reject"], required=True)
    parser.add_argument("--feedback", default="")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    client = make_client(args.environment)
    assignment = client.get_assignment(AssignmentId=args.assignment_id)["Assignment"]
    answers = parse_answer_xml(assignment.get("Answer", ""))
    worker_id = assignment.get("WorkerId", "")

    print(f"Environment: {args.environment}")
    print(f"AssignmentId: {args.assignment_id}")
    print(f"WorkerId: {worker_id}")
    print(f"Status: {assignment.get('AssignmentStatus', '')}")
    print(f"Completion code: {answers.get('completion_code', '')}")
    print(f"Session ID: {answers.get('session_id', '')}")

    if args.dry_run:
        print(f"Dry run: would {args.action} this assignment.")
        return

    if args.action == "approve":
        client.approve_assignment(
            AssignmentId=args.assignment_id,
            RequesterFeedback=args.feedback or "Thank you for completing the study.",
            OverrideRejection=False,
        )
        qualification_id = grant_completed_qualification(client, args.environment, worker_id)
        print("Approved assignment.")
        print(f"Granted completed-study qualification: {qualification_id}")
        return

    client.reject_assignment(
        AssignmentId=args.assignment_id,
        RequesterFeedback=args.feedback or "The submitted completion code could not be validated.",
    )
    print("Rejected assignment.")


if __name__ == "__main__":
    main()

