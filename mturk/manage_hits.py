#!/usr/bin/env python3
"""List and delete MTurk HITs in sandbox or production."""

from __future__ import annotations

import argparse
import json

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


def list_hits(client, max_hits: int) -> list[dict]:
    hits = []
    paginator = client.get_paginator("list_hits")
    for page in paginator.paginate(PaginationConfig={"PageSize": 100}):
        hits.extend(page.get("HITs", []))
        if len(hits) >= max_hits:
            break
    return hits[:max_hits]


def hit_row(hit: dict) -> dict:
    return {
        "hit_id": hit.get("HITId", ""),
        "hit_group_id": hit.get("HITGroupId", ""),
        "title": hit.get("Title", ""),
        "status": hit.get("HITStatus", ""),
        "created": str(hit.get("CreationTime", "")),
        "expires": str(hit.get("Expiration", "")),
        "assignments_available": hit.get("NumberOfAssignmentsAvailable", 0),
        "assignments_pending": hit.get("NumberOfAssignmentsPending", 0),
        "assignments_completed": hit.get("NumberOfAssignmentsCompleted", 0),
        "reward": hit.get("Reward", ""),
    }


def delete_hit(client, hit_id: str, force_expire: bool) -> None:
    hit = client.get_hit(HITId=hit_id)["HIT"]
    status = hit.get("HITStatus", "")

    if force_expire and status != "Disposed":
        client.update_expiration_for_hit(HITId=hit_id, ExpireAt=0)

    client.delete_hit(HITId=hit_id)


def main() -> None:
    parser = argparse.ArgumentParser(description="List or delete MTurk HITs.")
    parser.add_argument("command", choices=["list", "delete"])
    parser.add_argument("--environment", choices=["sandbox", "production"], default="sandbox")
    parser.add_argument("--hit-id", default="", help="Required for delete.")
    parser.add_argument("--max-hits", type=int, default=50)
    parser.add_argument("--force-expire", action="store_true", help="Expire the HIT before deleting it.")
    parser.add_argument("--yes", action="store_true", help="Actually delete. Without this, delete is a dry run.")
    args = parser.parse_args()

    client = make_client(args.environment)

    if args.command == "list":
        rows = [hit_row(hit) for hit in list_hits(client, args.max_hits)]
        print(json.dumps(rows, indent=2))
        return

    if not args.hit_id:
        raise SystemExit("ERROR: --hit-id is required for delete.")

    hit = client.get_hit(HITId=args.hit_id)["HIT"]
    print(json.dumps(hit_row(hit), indent=2))

    if not args.yes:
        print("Dry run: add --yes to delete this HIT.")
        print("If the HIT is still active, also add --force-expire.")
        return

    delete_hit(client, args.hit_id, args.force_expire)
    print(f"Deleted HIT: {args.hit_id}")


if __name__ == "__main__":
    main()

