# CLAUDE.md - MTurk VR Helper Dashboard Study

This file captures project knowledge for future AI coding agents working on the MTurk study app.

## Project Purpose

This repo contains a standalone MTurk web study for evaluating whether first-time, untrained users can understand and correctly use a simulated VR helper assistance dashboard.

Participants are not connected to Unity and are not actual VR helpers. They see a simulated version of the helper dashboard and answer prompts by clicking the dashboard region, button, dropdown, video, or tool that best answers the prompt.

The study measures:
- Whether participants choose the correct dashboard feature.
- How long they take to respond.
- What regions they click before their final answer.
- Attention-check performance.

## Current Architecture

Main app:
- React + Vite single-page app.
- Primary UI file: `src/App.jsx`.
- Styles: `src/styles.css`.
- 3D controller component: `src/controllers/Controller3DViewer.jsx` and `src/controllers/Controller3DViewer.css`.
- Static assets and JSON live under `public/`.

Backend:
- `server.js` serves the built app and receives metrics at `/api/session`.
- Saved session JSON files are written to `data/sessions/`.
- Excel-compatible XML export is available at `/api/export`.
- Session listing is available at `/api/sessions`.

Deployment:
- Frontend can be deployed to GitHub Pages.
- Backend can be deployed separately, for example Render during testing, and later a university server.
- `public/study-config.json` controls URLs such as backend metrics API and Qualtrics redirect URL.

## Important Files

- `src/App.jsx`
  - Study flow, consent, intro, attention checks, dashboard questions, completion page, metrics payload.
  - Simulated dashboard rendering is also inside this file.

- `public/ui-text.json`
  - Participant-facing static text outside of questions and attention checks.
  - Edit consent, intro, completion, access messages, dashboard labels, and region labels here.

- `public/questions.json`
  - Main study dashboard questions.
  - Each question has fields such as `question_id`, `prompt`, `correct_region_ids`, `question_type`, `screen_variant`, and `order`.

- `public/attention-checks.json`
  - Attention and comprehension checks.
  - Attention checks are mixed into the main study flow.
  - Do not add an early-stop/ineligible flow unless explicitly requested. Current desired behavior is not to end the study for failed attention checks.

- `public/task_metadata.json`
  - Task metadata reused from the actual assistance tool.
  - The MTurk app currently uses task 18 as the fixed current task in the dashboard simulation.
  - Demo videos, controller videos, object labels, icons, and written instructions come from here.

- `public/study-config.json`
  - Study name, MTurk parameter requirements, Qualtrics URL, metrics backend URL, completion-code prefix.

- `server.js`
  - Backend save/export logic.
  - If metrics columns need to change, update `flattenSessionRows()` and `buildExcelXml()` here.

- `scripts/mturk_assignments.py`
  - Helper script area for MTurk-related operations.

## Study Flow

1. MTurk worker opens the study through an ExternalQuestion HIT URL.
2. The frontend reads URL parameters:
   - `workerId`
   - `assignmentId`
   - `hitId`
   - `turkSubmitTo`
   - optional `participant_id`
3. Consent page appears.
4. If consent is declined, show thank-you/end page.
5. If consent is accepted, show introduction page.
6. Main study begins.
7. Attention checks are randomly inserted among dashboard questions.
8. For dashboard questions:
   - The simulated helper dashboard is shown inside a tablet-like UI.
   - The question prompt is shown separately from the tablet UI.
   - The participant can click any dashboard region/control.
   - Only the last clicked region before pressing Next is treated as the final answer.
   - Do not reveal correctness during the study.
9. At completion:
   - The frontend saves metrics to the backend.
   - The backend returns a completion code.
   - The participant opens Qualtrics in a new tab.
   - Qualtrics should show the same completion code to the participant.
   - Participant returns to MTurk page, enters the code, and submits the HIT.

## MTurk Integration

Use MTurk ExternalQuestion style, not a simple static survey link, so MTurk appends worker/assignment/HIT parameters.

Required URL parameters for live MTurk runs:
- `workerId`
- `assignmentId`
- `hitId`
- `turkSubmitTo`

Preview handling:
- If `assignmentId=ASSIGNMENT_ID_NOT_AVAILABLE`, show a preview/accept-HIT message.
- If required params are missing, show the MTurk-required page.

Completion-code flow:
- Backend generates or preserves a per-session completion code.
- Code format uses prefix from config, e.g. `VRHELP-XXXXXX-XXXXXX`.
- The app should not let the worker submit the HIT unless the entered code matches the backend-generated code.

Security note:
- GitHub Pages alone cannot securely validate or save metrics.
- A backend is needed for saved JSON, Excel export, and completion-code records.

## Metrics Model

The saved JSON payload should include:
- `session_id`
- `participant_id`
- `workerId`
- `assignmentId`
- `hitId`
- `turkSubmitTo`
- `completion_status`
- `attention_passed`
- `completion_code`
- `client_info`
- `timing`
- `attention_checks`
- `main_questions`

Current Excel export uses one row per screen/item, not one huge participant row.

Excel row types:
- `consent`
- `introduction`
- `attention`
- `attention_dashboard`
- `study_question`
- `completion`

Excel columns:
- `session_id`
- `participant_id`
- `workerId`
- `assignmentId`
- `hitId`
- `row_type`
- `row_id`
- `row_order`
- `screen_name`
- `prompt`
- `answer_given`
- `final_selected_region_id`
- `final_selected_base_region_id`
- `final_selected_region_label`
- `correct_answer`
- `is_correct`
- `requires_manual_review`
- `all_clicks_json`
- `first_interaction_timestamp`
- `last_interaction_timestamp`
- `screen_started_at`
- `screen_ended_at`
- `time_taken_ms`
- `completion_code`
- `browser`
- `screen_width`
- `screen_height`
- `study_status`
- `attention_passed`

Click records:
- `region_id` should be human-readable for dynamic controls.
  - Example: `object-button-Harpoon lever`
  - Example: `controller-object-dropdown-Fire button`
  - Example: `controller-side-dropdown-Right controller`
  - Example: `task-option-completed-4 Move the cargo barrels`
- `base_region_id` should preserve the stable scoring category.
  - Example: `object-button`
  - Example: `controller-object-dropdown`
  - Example: `completed-task`
- `region_label` should be readable for Excel review.

## Dashboard Simulation Rules

The dashboard is intentionally simulated. It should not connect to Unity, WebRTC, relay server, or Quest.

Current simulated behavior:
- Task 18 is treated as current in the MTurk dashboard.
- Current-task controls are enabled.
- Completed/future task controls are disabled, except video play/pause can remain interactable if explicitly required.
- Participants can still click dropdowns and regions for answers.
- Freehand drawing lets participants draw in yellow inside the VR view region.
- Clear button becomes enabled after annotations/interactions such as object button, video send, or freehand drawing.
- Send buttons simulate a video overlay in the VR user view, then change to remove video.
- Listen button plays/pauses the task audio and changes text between Listen and Playing.
- The dashboard should reset to default state when moving to the next question.

## Correctness Scoring

Main dashboard questions use `correct_region_ids` from `public/questions.json`.

Important special case:
- Dynamic object buttons are recorded as readable IDs like `object-button-Harpoon lever`.
- Scoring should still accept them if the correct region is `object-guide-button` or `object-highlight-button`, or if `base_region_id` is accepted.

## UI Text Policy

Participant-facing text should be in config files when practical.

Keep separate:
- `public/questions.json` for study questions.
- `public/attention-checks.json` for attention checks.
- `public/ui-text.json` for all other frontend text.

Avoid hardcoding visible participant text in `src/App.jsx` except as defensive fallbacks.

## Build And Local Run

Install dependencies:
```bash
npm install
```

Run frontend dev server:
```bash
npm run dev
```

Build frontend:
```bash
npm run build
```

Run backend locally:
```bash
node server.js
```

Backend default:
- `http://localhost:5174`
- Excel export: `http://localhost:5174/api/export`
- Sessions list: `http://localhost:5174/api/sessions`

## Verification Checklist Before Handing Back

Always run:
```bash
npm run build
node --check server.js
```

If changing metrics/export:
1. Start backend with `node server.js`.
2. Post or complete a dummy session.
3. Visit `/api/export`.
4. Confirm Excel contains row types for consent, introduction, attention, study_question, and completion.
5. Confirm dynamic clicked regions are readable, not just `object-button-0`.
6. Delete dummy session JSON from `data/sessions/` after testing.

If changing dashboard behavior:
1. Launch dev server.
2. Open with test MTurk params:
   `http://127.0.0.1:5173/?workerId=TESTWORKER&assignmentId=TESTASSIGNMENT&hitId=TESTHIT&turkSubmitTo=https%3A%2F%2Fworkersandbox.mturk.com%2Fmturk%2FexternalSubmit`
3. Accept consent.
4. Continue from intro.
5. Click object buttons, dropdowns, videos, freehand, clear.
6. Check browser console for runtime errors.

## Known Caveats

- The frontend bundle is larger than Vite's default warning threshold. This has been an existing warning, not a build failure.
- Keep generated metrics/session test files out of git.
- Do not commit `node_modules` or local data files.
- If `public/img/introduction/` is untracked, verify whether it is intentional before committing.

## Current Project Status Snapshot

As of the latest work:
- Participant-facing static UI text has been moved into `public/ui-text.json`.
- Missing dashboard helper functions were restored in `src/App.jsx`.
- Metrics export was changed to one row per screen/item.
- Dynamic clicks now use readable IDs instead of generic indexes where possible.
- Build and server syntax checks passed after the metrics changes.