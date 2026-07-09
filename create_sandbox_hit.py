import boto3

MTURK_SANDBOX = "https://mturk-requester-sandbox.us-east-1.amazonaws.com"

external_question_xml = """<?xml version="1.0" encoding="UTF-8"?>
<ExternalQuestion xmlns="http://mechanicalturk.amazonaws.com/AWSMechanicalTurkDataSchemas/2006-07-14/ExternalQuestion.xsd">
  <ExternalURL>https://yankanp.github.io/VR-assistance-tool-Mturk/</ExternalURL>
  <FrameHeight>0</FrameHeight>
</ExternalQuestion>
"""

client = boto3.client(
    "mturk",
    region_name="us-east-1",
    endpoint_url=MTURK_SANDBOX,
)

response = client.create_hit(
    Title="Evaluate a VR helper assistance dashboard",
    Description="Interact with a helper dashboard for a virtual reality application and answer study questions.",
    Keywords="survey, usability, virtual reality, research",
    Reward="0.50",
    MaxAssignments=1,
    LifetimeInSeconds=86400,
    AssignmentDurationInSeconds=1800,
    AutoApprovalDelayInSeconds=259200,
    Question=external_question_xml,
)

hit = response["HIT"]

print("HIT created")
print("HITId:", hit["HITId"])
print("Preview URL:")
print(f"https://workersandbox.mturk.com/mturk/preview?groupId={hit['HITGroupId']}")