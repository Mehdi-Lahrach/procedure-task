# Sludge Experiment — Researcher Guide

## What this is

This is a platform for running online experiments that measure the behavioral costs of administrative procedures. Participants complete a realistic, fictional government application — the **Green Zone Vehicle Access Permit** — while the system records granular behavioral data: how long each page takes, which reference documents participants consult (and for how long), where they make errors, and all their form responses.

The platform is designed to plug directly into **Prolific** for participant recruitment.

---

## The task

Participants are told they are role-playing as a resident of the fictional country of **Newland** who needs to apply for a vehicle access permit to enter a restricted environmental zone.

They receive a set of **6 fictional personal documents** (driving license, vehicle registration, insurance certificate, technical inspection report, electricity bill, water bill) displayed in a collapsible side panel. Clicking a document opens it in a **slide-out drawer** with zoom controls (zoom in/out buttons, reset, and Ctrl+scroll wheel), making it easy to read fine details. The application requires them to locate specific information in these documents and enter it into the form — mimicking the real experience of filling out government paperwork with documents at hand.

A **progress stepper** at the top of the page shows participants which section they're in (Applicant details → Eligibility → Vehicle details → Review & Submit). The stepper is only visible during the main application procedure — it does not appear on consent, instruction, post-task, or completion pages.

### Procedure flow (18 pages, with conditional skip)

| # | Page | What happens |
|---|------|-------------|
| 1 | **Consent** | Research ethics consent (checkbox + continue) |
| 2 | **Instructions** | Role-play briefing: who they are, what they need to do |
| 3 | **Confirm instructions** | Comprehension check before starting |
| 4 | **Applicant details** | Full name, date of birth, national ID (format: `ID-XXXXXX`), address, email, phone |
| 5 | **Eligibility rules + decision** | Complex eligibility criteria followed by eligibility assessment on the same page. **If "No" → skip to page 13** |
| 6 | **Document upload — eligibility** | Upload supporting documents for eligibility |
| 7 | **Document upload — residence** | Upload proof of residence |
| 8 | **Vehicle information** | Registration number (format: `AB-123-CD`), make, model, year |
| 9 | **Vehicle category** | Select vehicle category from a list |
| 10 | **Vehicle fuel type** | Select fuel type |
| 11 | **Vehicle environmental class** | Select environmental classification |
| 12 | **Review & submit** | Full application summary (all entered data) + declaration of accuracy checkboxes + submit button |
| 13 | **Ineligible end** | Shown only if participant selected "No" — explains application cannot proceed |
| 14 | **Demographics** | Post-task: age, gender, education, employment |
| 15 | **Attention check** | Post-task quality check |
| 16 | **Feedback** | Post-task: perceived difficulty, frustration, time perception |
| 17 | **Debrief** | Explanation of the study purpose |
| 18 | **Completion** | Prolific redirect button |

Pages 4–12 show the **document reference panel** on the right side. Pages 14–17 are post-task measures (no documents).

**Ineligibility skip**: If a participant selects "No — the applicant is not eligible" on page 5, they skip pages 6–12 entirely and land on the "Ineligible end" page (13), then continue to post-task questions. Their session is flagged as `ineligible_skipped=yes` in the CSV and their timing data is excluded from the main procedure timing averages. The correct answer is "Yes" (eligible), so this also counts as a quality error.

---

## What is tracked

### Per participant (one row in the CSV export)

**Timing:**
- Total session duration (ms)
- Application-only duration (excluding consent, instructions, post-task)
- Time spent on each individual page (ms) — **accumulated across revisits** (if a participant goes back and re-visits a page, the total time is the sum of all visits, not just the last one)

**Document behavior:**
- Number of times each document was opened (both accordion panel and drawer)
- Total time spent viewing each document (ms)
- Which documents were never consulted

**Validation errors** (formatting issues caught by the form):
- Total validation errors across the session
- Errors per page (which pages cause the most trouble) — **accumulated across revisits** (if a participant revisits a page and triggers errors again, they add to the running total)
- Errors per field (which specific fields are problematic)

**Application quality scoring** (substantive errors in the submitted application):
- The server automatically checks each submitted application against the **correct answers** derived from the fictional documents (name, DOB, national ID, eligibility decision, supporting documents, vehicle registration, owner type, category, fuel type, environmental classification)
- `quality_errors`: number of fields with substantive errors (wrong information, not just formatting)
- `quality_would_reject`: whether the application would be rejected by the administration (`yes` / `no`)
- `quality_error_fields`: which fields were wrong (semicolon-separated)
- `quality_error_details`: full detail of each error (submitted value vs. expected value)
- This is distinct from validation errors — validation errors are formatting mistakes caught and corrected during the procedure; quality errors are factual mistakes in the final submitted application that the participant may not have noticed

**Form responses:**
- Every field value entered by the participant (stores the final values; overwritten on revisit)
- Includes both application fields and post-task survey responses

**Session metadata:**
- Prolific PID, study ID, condition code
- Device info (screen size, browser, timezone, language)
- Consent status, completion status (`complete` / `submitted` / `ineligible` / `dropped` / `incomplete`)

**All data is per-participant.** The dashboard and CSV export aggregate timing and error data per session first, so each participant is counted once per page — not once per visit. This means the average time on a page reflects what a typical participant spent on it in total, even if some participants visited it multiple times.

### Event-level data (for deeper analysis)

Raw event streams are also stored if you need finer granularity: every page transition, every click, field focus/blur events, tab visibility changes, scroll behavior.

### Session persistence & duplicate prevention

If a participant refreshes the page or loses connection, their session **resumes from where they left off** — progress (page index + form data) is saved to the server on every page transition. If a participant tries to start the study a second time (same Prolific PID), they see a "Study already completed" screen and cannot create a duplicate session.

---

## How to access the data

### During data collection

Open the **live dashboard** at:
```
http://YOUR_SERVER/dashboard?key=research2025
```

This shows: color-coded status cards (complete/partial/incomplete/ineligible counts, full-procedure session count), completion rate, timing averages (computed from full-procedure sessions only, excluding ineligible), validation error rate, **application quality scoring** (rejection rate with per-field error breakdown table), page-by-page timing and validation error breakdown, document viewing rates, and drop-off analysis (where partial sessions stopped). The dashboard clearly distinguishes validation errors (formatting issues caught during the form) from quality errors (substantive mistakes in the submitted application).

### After data collection

**Flat CSV (recommended for analysis):**
```
http://YOUR_SERVER/api/export/csv?key=research2025
```

One row per participant. Columns include all base metrics, per-page timings (`time_applicant_details_ms`, `time_vehicle_info_ms`, ...), per-document stats (`doc_driving_license_opens`, `doc_driving_license_totalMs`, ...), per-page validation error counts (`errors_applicant_details`, ...), all form field responses as individual columns, application quality scoring columns (`quality_errors`, `quality_would_reject`, `quality_error_fields`, `quality_error_details`), and `ineligible_skipped` (`yes`/`no` — whether the participant selected "not eligible" and was skipped past the procedure). When analysing timing data, filter on `ineligible_skipped=no` to get only participants who completed the full procedure.

**Full JSON (all event-level data):**
```
http://YOUR_SERVER/api/export/all/json?key=research2025
```

### Import into R
```r
library(jsonlite)
# Full data
data <- fromJSON("http://YOUR_SERVER/api/export/all/json?key=research2025")
sessions <- data$sessions

# Or just the flat CSV
df <- read.csv("http://YOUR_SERVER/api/export/csv?key=research2025")
```

### Import into Python
```python
import pandas as pd

# Flat CSV
df = pd.read_csv("http://YOUR_SERVER/api/export/csv?key=research2025")

# Or full JSON
import requests
data = requests.get("http://YOUR_SERVER/api/export/all/json?key=research2025").json()
sessions = pd.DataFrame(data["sessions"])
```

---

## Prolific setup

### Study URL

```
http://YOUR_SERVER/?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}
```

To assign participants to experimental conditions, add a `CONDITION` parameter:
```
http://YOUR_SERVER/?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}&CONDITION=treatment
```

### Completion URL

Before launching, you need to set your Prolific completion code in the file `public/js/procedure_greenzone.js`:

```javascript
prolificCompletionUrl: 'https://app.prolific.com/submissions/complete?cc=YOUR_CODE_HERE',
```

Replace `XXXXXXX` with the actual completion code from your Prolific study setup.

### Recommended Prolific settings

- **Estimated completion time**: 10–15 minutes (test this yourself first)
- **Device**: Desktop only (the document panel doesn't work well on mobile)
- **Allowed to return**: No

---

## Running the platform

### Local testing
```bash
npm install
npm start
# Opens on http://localhost:3001
```

### Deployment

The platform is a standard Node.js app. Deploy to any server that supports Node (Railway, Render, a VPS, etc.). The only requirement is Node.js 18+.

Set the `EXPORT_KEY` environment variable to something secure before going live:
```bash
EXPORT_KEY=your_secret_key npm start
```

All data is stored in the `/data/` folder as `.jsonl` files. **Back up this folder** — it's your raw data.

---

## Experimental conditions

The platform supports multiple procedure variants via URL parameters. Currently there is one procedure (`GREENZONE_PROCEDURE`). To create experimental conditions:

1. Create variant procedure definitions in `procedure_greenzone.js` (e.g., a shorter version, a version without the document panel, a version with simpler rules)
2. In `index.html`, update the condition routing logic (around line 142) to select the right procedure based on the `CONDITION` URL parameter
3. In Prolific, use URL parameters to assign conditions

The `condition_code` is recorded in every session and appears in the CSV export, so you can filter and compare groups directly.

---

## Key design decisions

**Why a fictional country?** To avoid participants bringing real-world knowledge about specific government systems. Everyone starts from the same baseline.

**Why embedded document images?** Earlier versions linked to Google Drive documents, which introduced tracking blind spots and reliability issues. Embedded images ensure every document interaction is captured.

**Why JSONL storage instead of a database?** Simplicity. The files are easy to back up, inspect, and debug. For the expected scale (hundreds to low thousands of participants), file-based storage is more than sufficient.

**Why no framework (React, etc.)?** The frontend is vanilla JavaScript to minimize bundle size and load time. Participants on Prolific may have variable connection quality, and the procedural page-by-page flow doesn't benefit from a SPA framework.

---

## Troubleshooting

**"Service temporarily unavailable" on load**: The server isn't running or isn't reachable. Check that `npm start` is running and the port is accessible.

**No data appearing in dashboard**: Check that the `/data/` directory exists and is writable. Look at the server console output for errors.

**Participant can't complete**: The most common issue is pattern validation — the fictional ID format (`ID-XXXXXX`) and registration format (`AB-123-CD`) are strict. The instructions page explains these formats, and real-time validation shows errors on blur, but some participants may still struggle. This is by design (it's sludge).

**Participant says "Study already completed"**: Their Prolific PID was already used. This is the duplicate prevention system working correctly. If you need to let them retry (e.g., during testing), delete their session from the `.jsonl` files.

**Participant refreshed and lost progress**: This should not happen — sessions auto-resume on page refresh. If it does, check the server logs for errors on the `/api/session/resume` endpoint.

**Need to reset data**: Delete the `.jsonl` files in the `/data/` folder and restart the server.

---

## File reference

| File | What to edit it for |
|------|-------------------|
| `public/js/procedure_greenzone.js` | Change the task content, add/remove pages or fields, set Prolific URL, configure stepper sections |
| `public/index.html` | Change branding, add condition routing |
| `public/css/gov.css` | Change visual styling (document drawer, stepper, layout) |
| `public/images/` and `public/docs/` | Replace document images (panel and drawer respectively) |
| `src/server.js` | Change export key, add endpoints, modify dashboard |
| `public/js/engine.js` | Change how pages render, validate, or navigate (rarely needed) |
| `public/js/tracker.js` | Change what behavioral data is collected (rarely needed) |
