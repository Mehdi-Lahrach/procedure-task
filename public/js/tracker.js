/**
 * SludgeTracker — Behavioral tracking for sludge experiments
 *
 * Tracks:
 * - Session metadata (Prolific IDs, condition, timestamps)
 * - Per-page timing (enter/exit, duration)
 * - Document panel interactions (which docs opened, duration each)
 * - Validation errors (per field, per page, totals)
 * - Form responses
 * - UI events (clicks, scrolls, tab visibility)
 * - Aggregate metrics (total time, total errors, total doc time)
 *
 * Session persistence:
 * - Resumes existing sessions on page refresh (via Prolific PID or cookie)
 * - Saves progress (page index + form data) on every page transition
 * - Prevents duplicate participation
 */
class SludgeTracker {
  constructor(options = {}) {
    this.apiBase = options.apiBase || '';
    this.flushInterval = options.flushInterval || 10000;
    this.sessionId = null;
    this.eventBuffer = [];
    this.flushTimer = null;

    // ── Per-page timing ──
    this.pageTimings = [];          // {pageId, pageIndex, enterTime, exitTime, durationMs}
    this.currentPageEntry = null;   // {pageId, pageIndex, enterTime}

    // ── Document interactions ──
    this.docInteractions = [];      // {docId, pageId, openTime, closeTime, durationMs}
    this.openDocs = {};             // docId -> {openTime, pageId}

    // ── Validation errors ──
    this.validationErrors = [];     // {pageId, fieldName, errorMessage, timestamp}
    this.errorCountsByPage = {};    // pageId -> count
    this.errorCountsByField = {};   // fieldName -> count
    this.totalErrors = 0;

    // ── Form data ──
    this.formResponses = {};        // pageId -> {field: value, ...}

    // ── Session timing ──
    this.sessionStartTime = null;
    this.sessionEndTime = null;

    // ── Tab visibility ──
    this._setupVisibilityTracking();
  }

  // ============================================================
  // SESSION MANAGEMENT (with resume support)
  // ============================================================

  async initSession() {
    const urlParams = new URLSearchParams(window.location.search);
    const prolificPid = urlParams.get('PROLIFIC_PID') || null;
    const cookieSid = this._getCookie('sludge_session_id');

    // 1. Try to resume an existing session
    try {
      const resumeParams = [];
      if (prolificPid) resumeParams.push(`pid=${encodeURIComponent(prolificPid)}`);
      else if (cookieSid) resumeParams.push(`sid=${encodeURIComponent(cookieSid)}`);

      if (resumeParams.length > 0) {
        const resumeResp = await fetch(`${this.apiBase}/api/session/resume?${resumeParams.join('&')}`);
        const resumeData = await resumeResp.json();

        if (resumeData.found) {
          if (resumeData.is_complete) {
            // Already completed — signal to caller
            return { already_complete: true };
          }
          // Resume existing session
          this.sessionId = resumeData.session_id;
          this.condition = resumeData.condition || null;
          this.sessionStartTime = Date.now();
          this._setCookie('sludge_session_id', this.sessionId, 7);
          this._startFlushing();
          return {
            sessionId: this.sessionId,
            condition: this.condition,
            resumeState: {
              currentPageIndex: resumeData.currentPageIndex || 0,
              formData: resumeData.formData || {},
            },
          };
        }
      }
    } catch (e) {
      console.warn('Resume check failed, creating new session:', e);
    }

    // 2. No existing session — create a new one
    try {
      const resp = await fetch(`${this.apiBase}/api/session/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prolificPid: prolificPid || 'unknown',
          studyId: urlParams.get('STUDY_ID') || 'unknown',
          sessionId: urlParams.get('SESSION_ID') || this._uuid(),
          procedureId: urlParams.get('PROCEDURE') || 'default',
          condition: urlParams.get('CONDITION') || 'default',
          userAgent: navigator.userAgent,
          screenWidth: window.screen.width,
          screenHeight: window.screen.height,
          windowWidth: window.innerWidth,
          windowHeight: window.innerHeight,
        }),
      });
      const data = await resp.json();
      this.sessionId = data.session_id;
      this.condition = data.condition || null;
      this.sessionStartTime = Date.now();
      this._setCookie('sludge_session_id', this.sessionId, 7);
      this._startFlushing();
      return { sessionId: this.sessionId, condition: this.condition };
    } catch (e) {
      console.error('Tracker init failed:', e);
      return null;
    }
  }

  // ============================================================
  // PROGRESS PERSISTENCE
  // ============================================================

  async saveProgress(currentPageIndex, formData, currentPageId) {
    if (!this.sessionId) return;
    try {
      await fetch(`${this.apiBase}/api/session/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: this.sessionId,
          currentPageIndex,
          currentPageId: currentPageId || null,
          formData,
        }),
      });
    } catch (e) {
      console.warn('Failed to save progress:', e);
    }
  }

  /**
   * Send a snapshot of current tracker data (timing, errors, documents, form responses).
   * Called when the application is submitted so that "submitted" sessions have their data
   * available for the dashboard even if the participant drops out before final completion.
   */
  async sendSnapshot() {
    if (!this.sessionId) return;

    // Close the current page entry so its timing is included
    const currentEntry = this.currentPageEntry;
    if (currentEntry && !currentEntry.exitTime) {
      currentEntry.exitTime = Date.now();
      currentEntry.durationMs = currentEntry.exitTime - currentEntry.entryTime;
    }

    const totalDurationMs = Date.now() - this.sessionStartTime;

    // Aggregate page timings (same logic as completeSession)
    const pageSummary = this.pageTimings.map(t => ({
      pageId: t.pageId, entryTime: t.entryTime, exitTime: t.exitTime || Date.now(), durationMs: t.durationMs || (Date.now() - t.entryTime),
    }));

    const nonAppPages = ['consent', 'instructions', 'confirm_instructions',
      'application_submitted', 'demographics', 'attention_check',
      'feedback', 'debrief', 'completion'];
    const applicationDurationMs = pageSummary
      .filter(t => !nonAppPages.includes(t.pageId))
      .reduce((sum, t) => sum + t.durationMs, 0);

    try {
      await fetch(`${this.apiBase}/api/session/snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: this.sessionId,
          totalDurationMs,
          applicationDurationMs,
          totalDocTimeMs: this.docInteractions.reduce((s, d) => s + d.durationMs, 0),
          totalDocOpens: this.docInteractions.length,
          totalErrors: this.totalErrors,
          errorCountsByPage: this.errorCountsByPage,
          errorCountsByField: this.errorCountsByField,
          pageTimings: this.pageTimings,
          docInteractions: this.docInteractions,
          formResponses: this.formResponses,
        }),
      });
    } catch (e) {
      console.warn('Failed to send snapshot:', e);
    }

    // Re-open the current page entry so tracking continues
    if (currentEntry && currentEntry.exitTime) {
      currentEntry.exitTime = null;
      currentEntry.durationMs = 0;
    }
  }

  // ============================================================
  // COOKIE HELPERS
  // ============================================================

  _setCookie(name, value, days) {
    const expires = new Date(Date.now() + days * 86400000).toUTCString();
    document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
  }

  _getCookie(name) {
    const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : null;
  }

  _uuid() {
    return 'xxxxxxxx-xxxx-4xxx'.replace(/x/g, () => (Math.random() * 16 | 0).toString(16)) + '-' + Date.now().toString(36);
  }

  // ============================================================
  // PAGE TIMING
  // ============================================================

  enterPage(pageId, pageIndex) {
    if (this.currentPageEntry) {
      this.exitPage();
    }
    this.currentPageEntry = {
      pageId,
      pageIndex,
      enterTime: Date.now(),
    };
    this._pushEvent('page_enter', { pageId, pageIndex });
  }

  exitPage() {
    if (!this.currentPageEntry) return;
    const exitTime = Date.now();
    const timing = {
      pageId: this.currentPageEntry.pageId,
      pageIndex: this.currentPageEntry.pageIndex,
      enterTime: this.currentPageEntry.enterTime,
      exitTime,
      durationMs: exitTime - this.currentPageEntry.enterTime,
    };
    this.pageTimings.push(timing);
    this._pushEvent('page_exit', {
      pageId: timing.pageId,
      pageIndex: timing.pageIndex,
      durationMs: timing.durationMs,
    });
    this._closeAllOpenDocs();
    this.currentPageEntry = null;
  }

  // ============================================================
  // DOCUMENT TRACKING
  // ============================================================

  documentOpened(docId) {
    const pageId = this.currentPageEntry?.pageId || 'unknown';
    this.openDocs[docId] = { openTime: Date.now(), pageId };
    this._pushEvent('doc_open', { docId, pageId });
  }

  documentClosed(docId) {
    if (!this.openDocs[docId]) return;
    const closeTime = Date.now();
    const entry = this.openDocs[docId];
    const interaction = {
      docId,
      pageId: entry.pageId,
      openTime: entry.openTime,
      closeTime,
      durationMs: closeTime - entry.openTime,
    };
    this.docInteractions.push(interaction);
    this._pushEvent('doc_close', {
      docId,
      pageId: entry.pageId,
      durationMs: interaction.durationMs,
    });
    delete this.openDocs[docId];
  }

  _closeAllOpenDocs() {
    Object.keys(this.openDocs).forEach(docId => this.documentClosed(docId));
  }

  // ============================================================
  // VALIDATION ERROR TRACKING
  // ============================================================

  recordValidationErrors(pageId, errors) {
    if (!errors || errors.length === 0) return;
    const timestamp = Date.now();
    errors.forEach(err => {
      this.validationErrors.push({
        pageId,
        fieldName: err.name,
        errorMessage: err.message,
        timestamp,
      });
      this.errorCountsByField[err.name] = (this.errorCountsByField[err.name] || 0) + 1;
    });
    this.errorCountsByPage[pageId] = (this.errorCountsByPage[pageId] || 0) + errors.length;
    this.totalErrors += errors.length;
    this._pushEvent('validation_errors', {
      pageId,
      errorCount: errors.length,
      fields: errors.map(e => e.name),
    });
  }

  // ============================================================
  // FORM RESPONSES
  // ============================================================

  recordFormResponses(pageId, data) {
    this.formResponses[pageId] = data;
    this._pushEvent('form_responses', { pageId, data });
  }

  recordSkip(fromPageId, toPageId, formData) {
    this._pushEvent('navigation', {
      action: 'skip',
      fromPageId,
      toPageId,
      reason: formData._skip_reason || 'conditional_skip',
    });
  }

  // ============================================================
  // SESSION COMPLETION
  // ============================================================

  async completeSession() {
    this.exitPage();
    this.sessionEndTime = Date.now();
    const totalDurationMs = this.sessionEndTime - this.sessionStartTime;

    // Document aggregates
    const docSummary = {};
    this.docInteractions.forEach(d => {
      if (!docSummary[d.docId]) docSummary[d.docId] = { opens: 0, totalMs: 0 };
      docSummary[d.docId].opens++;
      docSummary[d.docId].totalMs += d.durationMs;
    });

    // Page timing map — accumulate total time across all visits to each page
    const pageSummary = {};
    this.pageTimings.forEach(t => {
      if (!pageSummary[t.pageId]) {
        pageSummary[t.pageId] = { durationMs: 0, pageIndex: t.pageIndex };
      }
      pageSummary[t.pageId].durationMs += t.durationMs;
    });

    // Application-only time (exclude research/post-task pages)
    const nonAppPages = ['consent', 'instructions', 'confirm_instructions',
      'application_submitted', 'demographics', 'attention_check',
      'feedback', 'debrief', 'completion'];
    const applicationDurationMs = this.pageTimings
      .filter(t => !nonAppPages.includes(t.pageId))
      .reduce((sum, t) => sum + t.durationMs, 0);

    const summary = {
      totalDurationMs,
      applicationDurationMs,
      totalErrors: this.totalErrors,
      errorsByPage: this.errorCountsByPage,
      errorsByField: this.errorCountsByField,
      pageTimings: pageSummary,
      documentInteractions: docSummary,
      totalDocTimeMs: this.docInteractions.reduce((s, d) => s + d.durationMs, 0),
      totalDocOpens: this.docInteractions.length,
    };

    this._pushEvent('session_complete', summary);
    await this._flush();

    // Send final summary — fields at top level for server compatibility
    try {
      await fetch(`${this.apiBase}/api/session/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: this.sessionId,
          totalDurationMs: summary.totalDurationMs,
          applicationDurationMs: summary.applicationDurationMs,
          totalDocTimeMs: summary.totalDocTimeMs,
          totalDocOpens: summary.totalDocOpens,
          totalErrors: summary.totalErrors,
          errorCountsByPage: this.errorCountsByPage,
          errorCountsByField: this.errorCountsByField,
          pageTimings: this.pageTimings,
          docInteractions: this.docInteractions,
          formResponses: this.formResponses,
        }),
      });
    } catch (e) {
      console.error('Failed to send session summary:', e);
    }

    this._stopFlushing();
  }

  // ============================================================
  // TAB VISIBILITY
  // ============================================================

  _setupVisibilityTracking() {
    document.addEventListener('visibilitychange', () => {
      this._pushEvent('visibility_change', {
        hidden: document.hidden,
        pageId: this.currentPageEntry?.pageId || 'unknown',
      });
    });
  }

  // ============================================================
  // EVENT BUFFER & FLUSHING
  // ============================================================

  _pushEvent(type, data) {
    this.eventBuffer.push({
      type,
      timestamp: Date.now(),
      sessionId: this.sessionId,
      ...data,
    });
  }

  _startFlushing() {
    this.flushTimer = setInterval(() => this._flush(), this.flushInterval);
  }

  _stopFlushing() {
    if (this.flushTimer) clearInterval(this.flushTimer);
  }

  async _flush() {
    if (this.eventBuffer.length === 0 || !this.sessionId) return;
    const events = [...this.eventBuffer];
    this.eventBuffer = [];
    try {
      await fetch(`${this.apiBase}/api/events/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: this.sessionId, events }),
      });
    } catch (e) {
      this.eventBuffer = [...events, ...this.eventBuffer];
    }
  }
}
