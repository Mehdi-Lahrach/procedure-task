# Sludge Experiment Platform

A full-stack web application for running behavioral experiments on administrative procedures. Participants complete a realistic government service application while the platform tracks granular behavioral data (timing, errors, document viewing, form responses).

Built for Hugo's sludge audit research with the OECD — measuring the costs of administrative burden through controlled experiments.

---

## Quick Start

```bash
cd "procedure task"
npm install
npm start
# → Procedure: http://localhost:3001
# → Dashboard: http://localhost:3001/dashboard?key=research2025
# → CSV Export: http://localhost:3001/api/export/csv?key=research2025
```

Requires **Node.js 18+**.

---

## Architecture Overview

```
sludge-experiment/
├── public/                  # Frontend (served as static files)
│   ├── index.html           # Entry point — loads procedure + engine + tracker
│   ├── css/gov.css          # GOV.UK Design System styles (custom implementation)
│   ├── js/
│   │   ├── engine.js        # Core procedure engine — renders pages, validates, navigates
│   │   ├── tracker.js       # Behavioral tracking — timing, errors, documents, form data
│   │   ├── procedure_greenzone.js  # Procedure definition (the "Green Zone" permit task)
│   │   └── procedure_sample.js     # Minimal procedure example / template
│   ├── images/              # Fictional document images (in-page panel)
│   │   └── (6 document PNGs)
│   └── docs/                # Same documents (used by the slide-out drawer)
│       └── (6 document PNGs)
├── src/
│   └── server.js            # Express backend — sessions, events, CSV export, dashboard
├── data/                    # Auto-created at runtime — JSONL data files
├── package.json
├── README.md
└── RESEARCHER_README.md     # Human-friendly guide for researchers / collaborators
```

### How It Works

1. **Participant opens URL** (e.g., from Prolific with `?PROLIFIC_PID=xxx&STUDY_ID=yyy`)
2. **Tracker** initializes — tries to resume an existing session (via Prolific PID or cookie), or creates a new one
3. **Duplicate prevention** — if the participant already completed the study, they see a "Study already completed" message
4. **Engine** renders pages from the procedure definition one at a time, restoring progress if resuming
5. Participant progresses through: consent → instructions → form pages → document upload → review → submission
6. On each page: per-page timing recorded, document panel interactions tracked, validation errors counted
7. **Progress saved** on every page transition (page index + form data) — participants can resume if they refresh
8. On completion: full session summary sent to server (timings, errors, doc stats, all form responses)
9. Participant redirected to Prolific completion URL

---

## Key Components

### `engine.js` — Procedure Flow Engine

Renders procedure pages and manages navigation. Features:

- **Page types**: `intro`, `consent`, `form`, `info`, `review`, `upload`, `completion`
- **Field types**: `text`, `email`, `tel`, `number`, `textarea`, `select`, `radio`, `checkbox`, `date_group`, `file`
- **Validation**: Required fields, regex patterns, custom validation functions
- **Real-time validation**: Pattern fields validate on blur with red error states
- **Document panel**: Side panel with accordion-style document viewers, tracked open/close
- **Document drawer**: Slide-out overlay for viewing documents with zoom controls (zoom in/out, reset, Ctrl+scroll wheel)
- **Auto-collapse**: When the participant clicks Continue or Back, all open document accordions are closed and the slide-out drawer is dismissed automatically, keeping the form in focus
- **Section stepper**: Configurable progress indicator showing procedure sections (e.g., "Applicant details → Eligibility → Vehicle details → Declaration → Submit"). Only visible during the procedure, hidden on consent/post-task/completion pages. Controlled via `stepperSections` config array.
- **Progress bar**: Visual progress indicator
- **Back navigation**: Browser back blocked; optional in-page back buttons. Page timing pauses on the current page and resumes (not restarts) on the revisited page.
- **Date validation**: `date_group` fields get multi-level validation — missing fields, non-numeric input, range checks (month 1–12, day 1–31, year 1900–current), and real date verification (rejects impossible dates like Feb 30). All three inputs (day/month/year) get red borders on error.
- **Conditional skip** (`skipIf`): Pages can define a skip rule (field + value + targetPageId). If the condition is met after validation, navigation jumps to the target page. Used for the eligibility decision: selecting "No" skips the rest of the application.
- **Session persistence**: Progress (page index + form data) saved to server on every page transition. On refresh, session resumes from where the participant left off.
- **Consent recording**: Posts consent to server when checkbox is checked

### `tracker.js` — Behavioral Data Collection

Silently records everything researchers need:

| Category | What's recorded |
|----------|----------------|
| **Per-page timing** | Entry/exit timestamps, duration per page. **Accumulates across revisits** — if a participant goes back and re-visits a page, the total time for that page is the sum of all visits. |
| **Document interactions** | Which docs opened, how long each was viewed, open/close events (both accordion panel and drawer) |
| **Validation errors** | Error count per page, per field, total; which fields failed. **Accumulates across revisits** — errors from repeat visits are added to the running total. |
| **Form responses** | All field values per page (stores the final values; overwritten on revisit) |
| **Tab visibility** | When participant switches away from tab |
| **Session summary** | Total duration, application-only duration, total doc time, total errors |

All data is **per-participant**: the dashboard and stats aggregate timing and error counts per session first, so each participant is counted once per page (not once per visit).

Data is buffered client-side and flushed to the server every 10 seconds via `/api/events/batch`. Progress is saved on every page transition via `/api/session/progress`. On completion, a final summary is sent to `/api/session/complete`.

### `procedure_greenzone.js` — The Green Zone Permit Procedure

A fictional but realistic 19-page government application for a "Green Zone Vehicle Access Permit" in the fictional country of Newland. Includes:

- Personal details (name, DOB, national ID, address, contact)
- Vehicle information (registration, make/model, fuel type, insurance)
- Complex eligibility rules with specific format requirements (e.g., ID format `ID-XXXXXX`, registration format `AB-123-CD`)
- Document reference panel showing 6 fictional document images (accordion panel + slide-out drawer with zoom)
- Configurable section stepper: `stepperSections: ['Applicant details', 'Eligibility', 'Vehicle details', 'Review & Submit']`
- Combined review + declaration page (participants review all answers, then tick declaration checkboxes and submit)
- Post-task questionnaires (demographics, attention check, feedback, debrief)
- Prolific redirect on completion

### `server.js` — Express Backend

- **Session management**: Create, consent, progress (save), resume, complete
- **Session persistence**: In-memory `sessionIndex` cache with `sessions.jsonl` (creation) + `sessions_updates.jsonl` (updates). `getMergedSessions()` merges base + updates for a unified view.
- **Tracker state persistence**: `pageTimings`, `docInteractions`, error counts, and `sessionStartTime` are saved server-side with each progress update and restored on session resume. Fixes `applicationDurationMs=0` after page refresh.
- **Duplicate prevention**: Resume endpoint detects already-completed sessions and returns `already_complete` flag
- **Condition rebalancing**: Block randomizer ignores timed-out sessions (>30 min inactive). Dropout participants' condition slots are released so the next participant naturally restores balance between self/average conditions.
- **Completion status**: Each session is classified as `complete` (finished everything including post-task + Prolific redirect), `submitted` (submitted the application but dropped before finishing post-task — procedure data still exploitable), `ineligible` (selected "not eligible"), `dropped` (consented but did not submit), or `incomplete` (did not consent/barely started). Drop-off page tracked for partial sessions.
- **Event ingestion**: Batch endpoint accepting all event types → stored as JSONL files
- **Application quality scoring**: Each submitted application is automatically checked against an answer key derived from the fictional documents (name, DOB, national ID, eligibility decision, supporting documents, vehicle registration, owner type, category, fuel type, environmental class). Distinguishes substantive errors (wrong information → rejection) from formatting errors caught during the procedure.
- **Per-participant aggregation**: Stats and dashboard aggregate page timings and errors per-session first (one count per participant per page, not per visit)
- **CSV timing accumulation**: Per-page timing columns sum all visits to each page (including back-button revisits) rather than overwriting with the last visit. `applicationDurationMs` and CSV columns are now consistent.
- **Data export**:
  - `/api/export/csv` — **Flat CSV, one row per session** with all form data, per-page timings, document stats, error counts
  - `/api/export/all/json` — Full JSON dump of all tables
  - `/api/export/{table}` — Individual table export (JSON or CSV with `&format=csv`)
- **Ineligible session handling**: Sessions where the participant selected "not eligible" are flagged (`ineligible_skipped=yes` in CSV) and excluded from main timing averages
- **Attention check report**: Dashboard section showing pass/fail count with a table of failed Prolific PIDs and their answers. Compares `attention_response` against "i pay attention" (case-insensitive, trimmed).
- **Participant exclusion**: Dashboard accepts comma-separated Prolific PIDs to exclude from all calculations. Persists in URL for bookmarking/sharing.
- **Quality bonus**: Instructions page shows a £0.50 bonus notice for submitting an error-free application (would be approved, no rejection errors).
- **Dashboard**: `/dashboard` — Live stats with color-coded status cards (including ineligible count), application quality scoring section (rejection rate + per-field error table), page-by-page timing and validation error breakdown, document interaction rates, attention check report, drop-off analysis
- **Authentication**: All export/stats endpoints require `?key=research2025` (configurable via `EXPORT_KEY` env var)

---

## Data Files (auto-created in `/data/`)

| File | Contents |
|------|----------|
| `sessions.jsonl` | Session creation records |
| `sessions_updates.jsonl` | Consent, completion, and full session summaries |
| `page_events.jsonl` | Page enter/exit events |
| `click_events.jsonl` | Click tracking |
| `field_events.jsonl` | Field focus/blur/change events |
| `form_responses.jsonl` | Form data per page |
| `document_events.jsonl` | Document open/close events |
| `validation_events.jsonl` | Validation error events |
| `visibility_events.jsonl` | Tab visibility changes |
| `scroll_events.jsonl` | Scroll events |
| `navigation_events.jsonl` | Navigation attempts |

---

## CSV Export Format

The `/api/export/csv` endpoint produces **one row per session** with columns:

- **Base**: `session_id`, `prolific_pid`, `study_id`, `condition_code`, `started_at`, `completed_at`, `totalDurationMs`, `totalErrors`, `totalDocTimeMs`, `totalDocOpens`
- **Per-page timing**: `time_{pageId}_ms` for each page
- **Per-document**: `doc_{docId}_opens`, `doc_{docId}_totalMs` for each document
- **Per-page errors**: `errors_{pageId}` for each page
- **Application quality scoring**: `quality_errors` (count of substantive errors), `quality_would_reject` (`yes`/`no`), `quality_error_fields` (semicolon-separated list), `quality_error_details` (submitted vs. expected for each error), `ineligible_skipped` (`yes`/`no`)
- **Over-documentation**: `overdoc_eligibility` (`yes`/`no`), `overdoc_eligibility_extras` (extra docs selected), `overdoc_eligibility_total_selected`, `overdoc_residence`, `overdoc_residence_selected`
- **Form responses**: One column per form field name, values flattened across pages

---

## Prolific Integration

URL parameters are automatically captured:

```
https://your-server.com/?PROLIFIC_PID=xxx&STUDY_ID=yyy&SESSION_ID=zzz&CONDITION=treatment
```

The completion page shows a "Return to Prolific" button. Set the actual Prolific completion URL in `procedure_greenzone.js`:

```javascript
prolificCompletionUrl: 'https://app.prolific.co/submissions/complete?cc=YOUR_CODE',
```

Currently set to a placeholder (`XXXXXX`).

---

## Creating New Procedures

To create a different administrative task (e.g., a tax filing, benefit application):

1. Copy `procedure_greenzone.js` (or `procedure_sample.js` for a minimal template)
2. Define your pages array — each page is an object with `id`, `type`, `title`, `fields`, etc.
3. Set `showDocumentsPanel`, `documentsPanelPages`, and `documentsPanelHtml` if you want a document reference panel
4. Set `stepperSections` to control which sections appear in the progress stepper
5. Update `index.html` to load your new procedure file
6. Add document images to `public/images/` and `public/docs/` if needed

### Page Definition Structure

```javascript
{
  id: 'unique_page_id',        // Used in tracking data
  type: 'form',                // intro | consent | form | info | review | upload | completion
  title: 'Page Title',
  section: 'Section Name',     // Optional caption above title
  description: 'Intro text',   // Optional
  body: '<p>HTML content</p>', // Optional rich HTML
  hint: 'Inset text hint',    // Optional, rendered as inset box
  fields: [                    // For form pages
    {
      name: 'field_name',      // Used as key in form data and CSV column
      type: 'text',            // text | email | tel | number | textarea | select | radio | checkbox | date_group | file
      label: 'Field Label',
      hint: 'Help text',       // Optional
      required: true,
      pattern: '^[A-Z]{2}$',   // Optional regex for validation
      patternMessage: 'Enter two uppercase letters',  // Shown on pattern fail
      errorMessage: 'Custom required error',          // Shown when empty
      options: ['A', 'B'],     // For select/radio/checkbox. Can also be {value, label, hint}
      width: '10',             // Input width class (2, 3, 4, 5, 10, 20, 30)
      validation: (val, formData) => { return null; } // Custom validation — return string on error, null on success
    }
  ],
  allowBack: true,             // Show back button
  buttonText: 'Continue',      // Override default button text
  // For info pages:
  customHtml: '<div>...</div>',// Raw HTML content
  insetText: 'Important note', // Rendered in inset box
  // For completion pages:
  whatHappensNext: 'We will process your application...',
  prolificRedirect: 'https://...',  // Alternative to config-level prolificCompletionUrl
}
```

### Document Panel Configuration

In the procedure config object:

```javascript
{
  showDocumentsPanel: true,
  documentsPanelPages: ['page_id_1', 'page_id_2'],  // Which pages show the panel
  documentsPanelHtml: buildDocumentsPanel(),          // HTML for the panel content
}
```

The panel uses `<details>` elements with class `document-accordion` and `data-doc-id` attributes for tracking.

---

## Configuration

| Setting | Location | Default |
|---------|----------|---------|
| Port | `PORT` env var | `3001` |
| Export key | `EXPORT_KEY` env var | `research2025` |
| Prolific URL | `procedure_greenzone.js` → `prolificCompletionUrl` | Placeholder |
| Stepper sections | `procedure_greenzone.js` → `stepperSections` | `['Applicant details', 'Eligibility', 'Vehicle details', 'Review & Submit']` |
| Flush interval | `index.html` → tracker options → `flushInterval` | 10000ms |
| Government name | `index.html` header | GOV.NEWLAND |

---

## API Endpoints

### Session Management
- `POST /api/session/create` — Create new session (body: prolific params, device info)
- `POST /api/session/consent` — Record consent (body: `{session_id}`)
- `POST /api/session/progress` — Save progress checkpoint (body: `{session_id, currentPageIndex, formData}`)
- `GET /api/session/resume?prolific_pid=xxx` — Resume an existing session (returns session data + `resumeState` or `already_complete`)
- `POST /api/session/complete` — Record completion with full summary

### Event Ingestion
- `POST /api/events/batch` — Batch event ingestion (body: `{session_id, events: [...]}`)

### Data Export (all require `?key=research2025`)
- `GET /api/export/csv` — Flat CSV, one row per session
- `GET /api/export/all/json` — Full JSON dump
- `GET /api/export/sessions` — Sessions table
- `GET /api/export/{table}` — Individual table (append `&format=csv` for CSV)
- `GET /api/stats` — Aggregated statistics (includes `quality_submitted`, `quality_rejected`, `quality_rejection_rate`, `quality_by_field` with per-field error counts and rates)
- `GET /dashboard` — Interactive dashboard

---

## Pending / TODO

- [ ] Set actual Prolific completion URL in procedure config
- [ ] Create additional procedure variants for experimental conditions (e.g., short version, no-documents version)
- [ ] Deploy to production server
- [ ] Run end-to-end test with Prolific sandbox

---

## Tech Stack

- **Frontend**: Vanilla JS, no build step, no framework dependencies
- **Backend**: Node.js + Express
- **Storage**: JSONL files (no database needed)
- **Styling**: Custom CSS based on GOV.UK Design System patterns
- **Dependencies**: `express`, `cors`, `uuid`
