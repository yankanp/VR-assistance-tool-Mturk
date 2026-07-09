# VR Helper MTurk Study

Standalone web study for evaluating whether first-time MTurk participants can identify and use the correct regions of the VR helper assistance dashboard.

This app does not connect to Unity, the relay server, WebRTC, or the Quest headset. It simulates the helper dashboard and records which feature region participants click for each prompt.

## Flow

1. Consent page
2. Study introduction
3. Main dashboard-click questions with attention checks distributed between them
4. Early-stop page if the participant fails an attention check
5. Completion page with deterministic completion code and Qualtrics redirect

## Configure

- `public/study-config.json`
  - `qualtricsRedirectUrl`
  - `metricsApiBaseUrl`
  - `attentionFailureThreshold`
  - consent/study text
- `public/questions.json`
  - Main study prompts and correct dashboard regions
- `public/attention-checks.json`
  - Attention checks and correct answers

Accepted URL parameters:

- `workerId`
- `assignmentId`
- `hitId`
- `participant_id`

Example:

```text
https://your-study-url.example/?workerId=A123&assignmentId=B456&hitId=C789&participant_id=P001
```

## Run Locally

```powershell
cd C:\Projects\VR-Projects\vr_assistance_tool\mturk-study
npm install
node server.js
```

In a second terminal, run the Vite dev server:

```powershell
cd C:\Projects\VR-Projects\vr_assistance_tool\mturk-study
npm run dev
```

Open the Vite URL shown in the terminal, usually:

```text
http://localhost:5173
```

The dev server proxies `/api/session` to `http://localhost:5174`, where `server.js` saves session metrics.

## Build

```powershell
cd C:\Projects\VR-Projects\vr_assistance_tool\mturk-study
npm run build
```

The static deployable site is created in:

```text
mturk-study/dist
```

Preview the production build:

```powershell
npm run serve
```

Open:

```text
http://localhost:5174
```

## Data

The app keeps the current session in browser `localStorage` while the participant is taking the study. When a session ends, the app automatically posts the metrics to:

```text
POST /api/session
```

The local study server writes each session as a JSON file in:

```text
mturk-study/data/sessions
```

This folder is ignored by Git.

Each session records:

- Participant URL parameters
- Consent version
- Session start/end timestamps
- Completion status
- Attention pass/fail result
- Main question responses
- Attention check responses
- Low-level click/response events

Export all saved sessions as an Excel-compatible file:

```text
http://localhost:5174/api/export
```

This downloads:

```text
mturk_metrics.xls
```

The completion code format is:

```text
VRHELP-${last6chars(session_id)}
```

## Qualtrics

Set `public/study-config.json`:

```json
{
  "qualtricsRedirectUrl": "https://YOUR_UNIVERSITY.qualtrics.com/jfe/form/YOUR_FORM_ID",
  "metricsApiBaseUrl": "https://YOUR_RENDER_BACKEND.onrender.com"
}
```

The app appends these query parameters to the Qualtrics URL:

- `participant_id`
- `workerId`
- `assignmentId`
- `hitId`
- `session_id`
- `completion_code`

In Qualtrics Survey Flow, create Embedded Data fields with the same names so the exit survey can connect back to the MTurk session metrics.

## MTurk Testing

For real MTurk HITs, deploy the built app and metrics server behind HTTPS. For development:

1. Run `npm run build`.
2. Run `npm run serve`.
3. Use a tunneling service or HTTPS deployment URL for MTurk Sandbox.
4. Create an ExternalQuestion HIT that points to the study URL.
5. Complete the HIT as a sandbox worker.
6. Confirm a JSON session appears in `mturk-study/data/sessions`.
7. Open `/api/export` to download the Excel metrics file.

## GitHub Pages Frontend + Render Backend

This app supports hosting the static frontend separately from the metrics backend.

1. Deploy the backend on Render with:

```text
Root directory: mturk-study
Build command: npm install && npm run build
Start command: npm run serve
```

2. Copy the Render URL, for example:

```text
https://your-study-backend.onrender.com
```

3. Set it in `public/study-config.json`:

```json
"metricsApiBaseUrl": "https://your-study-backend.onrender.com"
```

4. Deploy `dist` to GitHub Pages.

The frontend will POST metrics to:

```text
https://your-study-backend.onrender.com/api/session
```

and you can export metrics from:

```text
https://your-study-backend.onrender.com/api/export
```

For real data collection, restrict the backend CORS origin by setting this Render environment variable:

```text
CORS_ORIGIN=https://YOUR_GITHUB_USERNAME.github.io
```

If your GitHub Pages site is under a repository path, the app uses relative asset URLs by default. You can override the Vite base path during build with:

```powershell
$env:VITE_BASE_PATH='/your-repo-name/'
npm run build
```


## MTurk requester scripts

Install the requester dependency locally:

```powershell
pip install boto3
```

List submitted assignments for a HIT:

```powershell
python scripts/mturk_assignments.py list --hit-id YOUR_HIT_ID --sandbox
```

Validate submitted completion codes against saved study sessions on the backend:

```powershell
python scripts/mturk_assignments.py validate --hit-id YOUR_HIT_ID --sandbox --backend-url https://vr-assistance-tool-mturk-backend.onrender.com
```

Dry-run approval for valid assignments:

```powershell
python scripts/mturk_assignments.py approve --hit-id YOUR_HIT_ID --sandbox --backend-url https://vr-assistance-tool-mturk-backend.onrender.com
```

Actually approve valid assignments:

```powershell
python scripts/mturk_assignments.py approve --hit-id YOUR_HIT_ID --sandbox --backend-url https://vr-assistance-tool-mturk-backend.onrender.com --approve
```

Use the production requester endpoint by omitting `--sandbox`. The script only approves assignments whose MTurk-submitted completion code matches a completed saved session with the same worker ID, assignment ID, and HIT ID.
