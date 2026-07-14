# MTurk Click Replay Viewer

Standalone review tool for visually inspecting where MTurk participants clicked.

This folder is independent from the MTurk study app. It does not import or modify
any MTurk source code.

## What It Does

The script reads an exported MTurk metrics `.xlsx` file and generates an HTML
review report. For each participant and each study row, the report shows:

- participant/session information
- question text
- final answer and correctness
- time spent
- a reconstructed participant viewport with numbered click markers in timestamp order
- target element rectangles when the newer MTurk logs include bounding boxes

## Input Expected

The `.xlsx` file should include these columns:

- `session_id`
- `participant_id`
- `workerId`
- `screen_name`
- `question_asked`
- `final_answer`
- `all_clicked_elements`
- `click_count`
- `is_correct`
- `time_spent_ms`

`all_clicked_elements` should be a JSON array. Each click may contain:

```json
{
  "element_clicked": "object-button-Harpoon lever",
  "timestamp": "2026-07-13T12:00:00.000Z",
  "client_x": 632,
  "client_y": 418,
  "viewport_width": 1920,
  "viewport_height": 928,
  "target_rect": { "left": 742, "top": 500, "width": 190, "height": 58 },
  "dashboard_rect": { "left": 720, "top": 70, "width": 1160, "height": 700 }
}
```

## Usage

```powershell
cd C:\Projects\VR-Projects\vr_assistance_tool\mturk_click_replay_viewer
python generate_click_replay.py `
  --excel "C:\path\to\mturk_metrics.xlsx" `
  --out "C:\path\to\click_replay_report.html"
```

Then open `click_replay_report.html` in a browser.

## Notes

- For new MTurk records, the viewer uses captured viewport coordinates and
  target bounding boxes. A dashboard screenshot is not required.
- For older MTurk records that do not include `client_x`, `client_y`, and
  `target_rect`, the viewer falls back to older coordinate fields. Those older
  records may be approximate.
- This script uses only Python standard-library modules. No `pip install` is
  required.
