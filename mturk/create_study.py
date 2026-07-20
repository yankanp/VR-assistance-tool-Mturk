#!/usr/bin/env python3
"""Create the VR helper MTurk study HIT in sandbox or production."""

from __future__ import annotations

import argparse
import html
import json

import boto3

from mturk_config import (
    ENVIRONMENTS,
    STUDY,
    WORKER_ADULT_QUALIFICATION_ID,
    WORKER_LOCALE_QUALIFICATION_ID,
)


def make_client(environment_name: str):
    environment = ENVIRONMENTS[environment_name]
    kwargs = {
        "region_name": STUDY.aws_region,
        "endpoint_url": environment.endpoint_url,
    }
    if STUDY.aws_profile:
        return boto3.Session(profile_name=STUDY.aws_profile).client("mturk", **kwargs)
    return boto3.client("mturk", **kwargs)


def find_or_create_completed_qualification(client, environment_name: str) -> str:
    environment = ENVIRONMENTS[environment_name]
    if environment.completed_qualification_id:
        return environment.completed_qualification_id

    paginator = client.get_paginator("list_qualification_types")
    for page in paginator.paginate(
        Query=environment.completed_qualification_name,
        MustBeRequestable=False,
        MustBeOwnedByCaller=True,
    ):
        for qualification in page.get("QualificationTypes", []):
            if qualification.get("Name") == environment.completed_qualification_name:
                return qualification["QualificationTypeId"]

    response = client.create_qualification_type(
        Name=environment.completed_qualification_name,
        Keywords="vr helper study completed repeat exclusion",
        Description=STUDY.completion_qualification_description,
        QualificationTypeStatus="Active",
        AutoGranted=False,
    )
    return response["QualificationType"]["QualificationTypeId"]


def build_qualification_requirements(completed_qualification_id: str) -> list[dict]:
    requirements = [
        {
            "QualificationTypeId": WORKER_LOCALE_QUALIFICATION_ID,
            "Comparator": "In",
            "LocaleValues": [{"Country": country} for country in STUDY.allowed_countries],
            "ActionsGuarded": "DiscoverPreviewAndAccept",
        },
        {
            "QualificationTypeId": completed_qualification_id,
            "Comparator": "DoesNotExist",
            "ActionsGuarded": "DiscoverPreviewAndAccept",
        },
    ]

    if STUDY.require_adult:
        requirements.append(
            {
                "QualificationTypeId": WORKER_ADULT_QUALIFICATION_ID,
                "Comparator": "EqualTo",
                "IntegerValues": [1],
                "ActionsGuarded": "DiscoverPreviewAndAccept",
            }
        )

    return requirements


def build_external_question_xml(study_url: str) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<ExternalQuestion xmlns="http://mechanicalturk.amazonaws.com/AWSMechanicalTurkDataSchemas/2006-07-14/ExternalQuestion.xsd">
  <ExternalURL>{html.escape(study_url, quote=True)}</ExternalURL>
  <FrameHeight>{STUDY.frame_height}</FrameHeight>
</ExternalQuestion>
"""


def main() -> None:
    parser = argparse.ArgumentParser(description="Create the VR helper MTurk study HIT.")
    parser.add_argument("--environment", choices=["sandbox", "production"], default="sandbox")
    parser.add_argument("--assignments", type=int, default=STUDY.max_assignments, help="Batch size / MaxAssignments.")
    parser.add_argument("--study-url", default=STUDY.study_url)
    parser.add_argument("--dry-run", action="store_true", help="Print payload without creating the HIT.")
    args = parser.parse_args()

    if args.dry_run:
        completed_qualification_id = (
            ENVIRONMENTS[args.environment].completed_qualification_id
            or "<created-or-found-at-runtime>"
        )
    else:
        client = make_client(args.environment)
        completed_qualification_id = find_or_create_completed_qualification(client, args.environment)
    qualification_requirements = build_qualification_requirements(completed_qualification_id)
    question_xml = build_external_question_xml(args.study_url)

    payload = {
        "Title": STUDY.title,
        "Description": STUDY.description,
        "Keywords": STUDY.keywords,
        "Reward": STUDY.reward,
        "MaxAssignments": args.assignments,
        "LifetimeInSeconds": STUDY.lifetime_seconds,
        "AssignmentDurationInSeconds": STUDY.assignment_duration_seconds,
        "AutoApprovalDelayInSeconds": STUDY.auto_approval_delay_seconds,
        "Question": question_xml,
        "QualificationRequirements": qualification_requirements,
    }

    if args.dry_run:
        print(json.dumps(payload, indent=2))
        print(f"Completed qualification ID: {completed_qualification_id}")
        return

    response = client.create_hit(**payload)
    hit = response["HIT"]
    worker_url = ENVIRONMENTS[args.environment].worker_url

    print("HIT created")
    print(f"Environment: {args.environment}")
    print(f"HITId: {hit['HITId']}")
    print(f"HITGroupId: {hit['HITGroupId']}")
    print(f"Assignments: {args.assignments}")
    print(f"Completed qualification ID: {completed_qualification_id}")
    print(f"Preview URL: {worker_url}/mturk/preview?groupId={hit['HITGroupId']}")


if __name__ == "__main__":
    main()
