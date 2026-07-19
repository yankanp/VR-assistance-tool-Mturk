"""Shared MTurk configuration for the VR helper MTurk study.

Edit this file before creating sandbox or production HITs.
AWS credentials should come from your normal AWS setup, a named profile, or .env.
Do not put AWS secret keys in this file.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None

if load_dotenv:
    load_dotenv()

SANDBOX_ENDPOINT = "https://mturk-requester-sandbox.us-east-1.amazonaws.com"
PRODUCTION_ENDPOINT = "https://mturk-requester.us-east-1.amazonaws.com"

WORKER_LOCALE_QUALIFICATION_ID = "00000000000000000071"
WORKER_ADULT_QUALIFICATION_ID = "00000000000000000060"


@dataclass(frozen=True)
class EnvironmentConfig:
    name: str
    endpoint_url: str
    worker_url: str
    completed_qualification_name: str
    completed_qualification_id: str = ""


@dataclass(frozen=True)
class StudyConfig:
    title: str
    description: str
    keywords: str
    reward: str
    max_assignments: int
    lifetime_seconds: int
    assignment_duration_seconds: int
    auto_approval_delay_seconds: int
    frame_height: int
    study_url: str
    aws_region: str
    aws_profile: str
    allowed_countries: tuple[str, ...]
    require_adult: bool
    require_english_reading: bool
    completion_qualification_description: str


ENVIRONMENTS = {
    "sandbox": EnvironmentConfig(
        name="sandbox",
        endpoint_url=SANDBOX_ENDPOINT,
        worker_url="https://workersandbox.mturk.com",
        completed_qualification_name="VR_HELPER_STUDY_COMPLETED_SANDBOX",
        completed_qualification_id=os.getenv("MTURK_SANDBOX_COMPLETED_QUALIFICATION_ID", ""),
    ),
    "production": EnvironmentConfig(
        name="production",
        endpoint_url=PRODUCTION_ENDPOINT,
        worker_url="https://worker.mturk.com",
        completed_qualification_name="VR_HELPER_STUDY_COMPLETED",
        completed_qualification_id=os.getenv("MTURK_PRODUCTION_COMPLETED_QUALIFICATION_ID", ""),
    ),
}

STUDY = StudyConfig(
    title="Evaluating the understandability of real-time helper tool for single-user virtual reality application",
    description=(
        "This approximately 20-minute study evaluates how well someone can understand a helper tool designed fro assisting a person using a single-user virtual reality application. Participants will answer questions by interacting with a web-based interface. Compensation is provided upon completion of the study."
    ),
    keywords="URI research study, virtual reality, real-time helper tool",
    reward="4.00",
    max_assignments=10,
    lifetime_seconds=7 * 24 * 60 * 60,
    assignment_duration_seconds=30 * 60,
    auto_approval_delay_seconds=7 * 24 * 60 * 60,
    frame_height=0,
    study_url=os.getenv("MTURK_STUDY_URL", "https://yankanp.github.io/VR-assistance-tool-Mturk/"),
    aws_region=os.getenv("AWS_REGION", "us-east-1"),
    aws_profile=os.getenv("AWS_PROFILE", ""),
    allowed_countries=("US", "CA"),
    require_adult=True,
    require_english_reading=True,
    completion_qualification_description=(
        "Assigned to workers who have already completed the VR helper dashboard study. "
        "Workers with this qualification are excluded from future batches."
    ),
)
