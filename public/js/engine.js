/**
 * Sludge Experiment - Procedure Flow Engine v3
 *
 * Features:
 * - Declarative procedure definitions (swap procedure files for different tasks)
 * - Document panel with open/close tracking (time per document)
 * - Validation on submit (errors shown only when clicking Continue)
 * - Error counting per field, per page, and total
 * - Per-page timing via tracker
 * - Form data collection
 * - Prolific redirect on completion
 * - Section-based progress stepper
 * - Session persistence & resume on refresh
 */

class ProcedureEngine {
  constructor(procedureConfig, tracker, resumeState) {
    this.config = procedureConfig;
    this.pages = procedureConfig.pages;
    this.tracker = tracker;
    this.currentPageIndex = -1;
    this.formData = {};
    this.pageHistory = [];
    this.container = document.getElementById('page-container');
    this.stepperContainer = document.getElementById('stepper-container');

    // Build section map for stepper
    this.sections = this._buildSections();

    // Restore state if resuming
    if (resumeState) {
      this.formData = resumeState.formData || {};
    }
    this._resumePageIndex = resumeState ? (resumeState.currentPageIndex || 0) : 0;

    // Block browser back
    window.history.pushState(null, '', window.location.href);
    window.addEventListener('popstate', () => {
      window.history.pushState(null, '', window.location.href);
    });
  }

  start() {
    this._renderStepper();
    this.goToPage(this._resumePageIndex);
  }

  // ============================================================
  // SECTION-BASED PROGRESS STEPPER
  // ============================================================

  _buildSections() {
    const sections = [];
    const seen = new Set();
    const allowed = this.config.stepperSections || null; // optional filter
    this.pages.forEach((page, index) => {
      if (!page.section) return; // skip consent/completion
      if (allowed && !allowed.includes(page.section)) return; // skip non-stepper sections
      if (!seen.has(page.section)) {
        seen.add(page.section);
        sections.push({
          label: page.section,
          pageIndices: [index],
        });
      } else {
        const sec = sections.find(s => s.label === page.section);
        if (sec) sec.pageIndices.push(index);
      }
    });
    return sections;
  }

  _renderStepper() {
    if (!this.stepperContainer) return;
    if (this.sections.length === 0) return;

    let html = '<div class="gov-stepper">';
    this.sections.forEach((sec, i) => {
      html += `<div class="gov-stepper__step" data-section-index="${i}">`;
      html += `<div class="gov-stepper__line-before"></div>`;
      html += `<div class="gov-stepper__circle">${i + 1}</div>`;
      html += `<div class="gov-stepper__line-after"></div>`;
      html += `<div class="gov-stepper__label">${sec.label}</div>`;
      html += `</div>`;
    });
    html += '</div>';
    // Mobile compact display
    html += '<div class="gov-stepper-mobile" id="stepper-mobile-text"></div>';
    this.stepperContainer.innerHTML = html;
  }

  _updateStepper() {
    if (!this.stepperContainer) return;
    const page = this.pages[this.currentPageIndex];

    // Hide stepper on consent, completion, and pages outside the stepper sections
    const allowed = this.config.stepperSections || null;
    const outsideStepper = allowed && (!page.section || !allowed.includes(page.section));
    if (!page.section || page.type === 'consent' || page.type === 'completion' || outsideStepper) {
      this.stepperContainer.style.display = 'none';
      return;
    }
    this.stepperContainer.style.display = '';

    // Find current section index
    let currentSectionIndex = -1;
    for (let i = 0; i < this.sections.length; i++) {
      if (this.sections[i].label === page.section) {
        currentSectionIndex = i;
        break;
      }
    }

    // Update step states
    const steps = this.stepperContainer.querySelectorAll('.gov-stepper__step');
    steps.forEach((step, i) => {
      step.classList.remove('gov-stepper__step--completed', 'gov-stepper__step--current', 'gov-stepper__step--future');
      const circle = step.querySelector('.gov-stepper__circle');
      if (i < currentSectionIndex) {
        step.classList.add('gov-stepper__step--completed');
        circle.innerHTML = '&#10003;'; // checkmark
      } else if (i === currentSectionIndex) {
        step.classList.add('gov-stepper__step--current');
        circle.textContent = i + 1;
      } else {
        step.classList.add('gov-stepper__step--future');
        circle.textContent = i + 1;
      }
    });

    // Mobile text
    const mobileText = document.getElementById('stepper-mobile-text');
    if (mobileText && currentSectionIndex >= 0) {
      mobileText.textContent = `${page.section} (${currentSectionIndex + 1} of ${this.sections.length})`;
    }
  }

  // ============================================================
  // NAVIGATION
  // ============================================================

  goToPage(index) {
    if (index < 0 || index >= this.pages.length) return;

    // Exit previous page in tracker
    if (this.tracker && this.currentPageIndex >= 0) {
      this.tracker.exitPage();
    }

    this.currentPageIndex = index;
    const page = this.pages[index];

    // Update stepper
    this._updateStepper();

    // Enter new page in tracker
    if (this.tracker) {
      this.tracker.enterPage(page.id, index);
    }

    this.renderPage(page);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  nextPage() {
    const page = this.pages[this.currentPageIndex];

    if (page.type === 'form') {
      if (!this.validateCurrentPage()) return;
      this.collectFormData(page);
      if (this.tracker) {
        this._recordPageResponses(page);
      }
    }

    // Auto-collapse any open document previews before navigating
    this._collapseDocumentPreviews();

    this.pageHistory.push(this.currentPageIndex);
    this.goToPage(this.currentPageIndex + 1);

    // Save progress after navigation
    if (this.tracker) {
      this.tracker.saveProgress(this.currentPageIndex, this.formData);
    }
  }

  /**
   * Collapse all open document accordions and close the document drawer
   * so that the form remains in focus on the next page.
   */
  _collapseDocumentPreviews() {
    // Close all open <details> accordions in the documents panel
    document.querySelectorAll('.document-accordion[open]').forEach(acc => {
      acc.removeAttribute('open');
    });
    // Close the slide-out document drawer if open
    const drawer = document.querySelector('.doc-drawer');
    if (drawer) {
      drawer.classList.remove('doc-drawer--open');
      setTimeout(() => { drawer.remove(); }, 250);
    }
  }

  previousPage() {
    if (this.pageHistory.length > 0) {
      // Collect current page data before going back (so it's preserved)
      const page = this.pages[this.currentPageIndex];
      if (page.type === 'form') {
        this.collectFormData(page);
      }

      this._collapseDocumentPreviews();
      const prevIndex = this.pageHistory.pop();
      this.goToPage(prevIndex);

      // Save progress after navigation
      if (this.tracker) {
        this.tracker.saveProgress(this.currentPageIndex, this.formData);
      }
    }
  }

  _recordPageResponses(page) {
    const pageData = {};
    (page.fields || []).forEach(field => {
      if (field.type === 'radio') {
        const c = document.querySelector(`[name="${field.name}"]:checked`);
        pageData[field.name] = c ? c.value : '';
      } else if (field.type === 'checkbox') {
        pageData[field.name] = Array.from(document.querySelectorAll(`[name="${field.name}"]:checked`)).map(c => c.value);
      } else if (field.type === 'date_group') {
        const d = document.querySelector(`[name="${field.name}_day"]`)?.value || '';
        const m = document.querySelector(`[name="${field.name}_month"]`)?.value || '';
        const y = document.querySelector(`[name="${field.name}_year"]`)?.value || '';
        pageData[field.name] = `${d}/${m}/${y}`;
      } else {
        const el = document.querySelector(`[name="${field.name}"]`);
        pageData[field.name] = el ? el.value : '';
      }
    });
    this.tracker.recordFormResponses(page.id, pageData);
  }

  // ============================================================
  // VALIDATION (on submit)
  // ============================================================

  validateCurrentPage() {
    const page = this.pages[this.currentPageIndex];
    if (!page.fields) return true;

    let hasErrors = false;
    const errors = [];

    // Clear existing errors
    document.querySelectorAll('.gov-form-group--error').forEach(g => g.classList.remove('gov-form-group--error'));
    document.querySelectorAll('.gov-error-message').forEach(e => e.remove());
    const es = document.querySelector('.gov-error-summary');
    if (es) es.remove();

    page.fields.forEach(field => {
      const error = this._validateField(field);
      if (error) {
        hasErrors = true;
        errors.push(error);
        this._showFieldError(field.name, error.message);
      }
    });

    if (hasErrors) {
      // Error summary at top
      const summary = document.createElement('div');
      summary.className = 'gov-error-summary';
      summary.setAttribute('role', 'alert');
      summary.innerHTML = `
        <h2 class="gov-error-summary__title">There is a problem</h2>
        <ul class="gov-error-summary__list">
          ${errors.map(e => `<li><a href="#group-${e.name}">${e.message}</a></li>`).join('')}
        </ul>`;
      // Insert inside the main column (not the flex wrapper) to avoid breaking docs layout
      const target = this.container.querySelector('.page-content__main .gov-main__two-thirds')
        || this.container.querySelector('.gov-main__two-thirds')
        || this.container.querySelector('.page-content');
      if (target) target.insertBefore(summary, target.firstChild);
      summary.scrollIntoView({ behavior: 'smooth' });

      // Record errors in tracker
      if (this.tracker) {
        this.tracker.recordValidationErrors(page.id, errors);
      }
    }

    return !hasErrors;
  }

  _validateField(field) {
    let value;
    if (field.type === 'radio') {
      value = document.querySelector(`[name="${field.name}"]:checked`)?.value || '';
    } else if (field.type === 'checkbox') {
      value = document.querySelectorAll(`[name="${field.name}"]:checked`).length > 0 ? 'checked' : '';
    } else if (field.type === 'date_group') {
      const d = document.querySelector(`[name="${field.name}_day"]`)?.value.trim() || '';
      const m = document.querySelector(`[name="${field.name}_month"]`)?.value.trim() || '';
      const y = document.querySelector(`[name="${field.name}_year"]`)?.value.trim() || '';

      // Empty check
      if (field.required && (!d || !m || !y)) {
        const missing = [];
        if (!d) missing.push('day');
        if (!m) missing.push('month');
        if (!y) missing.push('year');
        return { name: field.name, message: field.errorMessage || `Date of birth must include a ${missing.join(', ')}` };
      }

      // Numeric check
      const day = parseInt(d, 10);
      const month = parseInt(m, 10);
      const year = parseInt(y, 10);
      if (isNaN(day) || isNaN(month) || isNaN(year)) {
        return { name: field.name, message: 'Date of birth must be a real date — enter numbers only' };
      }

      // Range check
      if (month < 1 || month > 12) {
        return { name: field.name, message: 'Month must be between 1 and 12' };
      }
      if (day < 1 || day > 31) {
        return { name: field.name, message: 'Day must be between 1 and 31' };
      }
      if (year < 1900 || year > new Date().getFullYear()) {
        return { name: field.name, message: `Year must be between 1900 and ${new Date().getFullYear()}` };
      }

      // Real date check (e.g., reject 31 Feb)
      const testDate = new Date(year, month - 1, day);
      if (testDate.getFullYear() !== year || testDate.getMonth() !== month - 1 || testDate.getDate() !== day) {
        return { name: field.name, message: 'Date of birth must be a real date' };
      }

      // Skip further validation (pattern etc.) — already validated
      return null;
    } else {
      value = document.querySelector(`[name="${field.name}"]`)?.value.trim() || '';
    }

    // Required check
    if (field.required && !value) {
      return { name: field.name, message: field.errorMessage || `Enter ${field.label.toLowerCase()}` };
    }

    // Pattern check
    if (value && field.pattern) {
      const regex = new RegExp(field.pattern);
      if (!regex.test(value)) {
        return { name: field.name, message: field.patternMessage || `Enter a valid ${field.label.toLowerCase()}` };
      }
    }

    // Custom validation
    if (value && field.validation) {
      const msg = field.validation(value, this.formData);
      if (msg) return { name: field.name, message: msg };
    }

    return null;
  }

  _showFieldError(fieldName, message) {
    const group = document.getElementById(`group-${fieldName}`);
    if (!group) return;
    group.classList.add('gov-form-group--error');
    // Remove any existing error message
    const existing = group.querySelector('.gov-error-message');
    if (existing) existing.remove();
    const errorEl = document.createElement('span');
    errorEl.className = 'gov-error-message';
    errorEl.id = `error-${fieldName}`;
    errorEl.textContent = message;
    // Insert after hint or label
    const anchor = group.querySelector('.gov-hint') || group.querySelector('.gov-label') || group.querySelector('legend');
    if (anchor) {
      anchor.insertAdjacentElement('afterend', errorEl);
    } else {
      group.prepend(errorEl);
    }
    // Also add red border to input(s) — date_group has multiple inputs
    const inputs = group.querySelectorAll('input, textarea, select');
    inputs.forEach(inp => inp.classList.add('gov-input--error'));
  }

  _clearFieldError(fieldName) {
    const group = document.getElementById(`group-${fieldName}`);
    if (!group) return;
    group.classList.remove('gov-form-group--error');
    const err = group.querySelector('.gov-error-message');
    if (err) err.remove();
    const inputs = group.querySelectorAll('input, textarea, select');
    inputs.forEach(inp => inp.classList.remove('gov-input--error'));
  }

  // ============================================================
  // FORM DATA COLLECTION
  // ============================================================

  collectFormData(page) {
    if (!page.fields) return;
    page.fields.forEach(field => {
      if (field.type === 'radio') {
        const c = document.querySelector(`[name="${field.name}"]:checked`);
        this.formData[field.name] = c ? c.value : '';
      } else if (field.type === 'checkbox') {
        this.formData[field.name] = Array.from(document.querySelectorAll(`[name="${field.name}"]:checked`)).map(c => c.value);
      } else if (field.type === 'date_group') {
        const d = document.querySelector(`[name="${field.name}_day"]`)?.value || '';
        const m = document.querySelector(`[name="${field.name}_month"]`)?.value || '';
        const y = document.querySelector(`[name="${field.name}_year"]`)?.value || '';
        this.formData[field.name] = `${d}/${m}/${y}`;
      } else {
        const el = document.querySelector(`[name="${field.name}"]`);
        this.formData[field.name] = el ? el.value : '';
      }
    });
  }

  // ============================================================
  // DOCUMENT PANEL TRACKING
  // ============================================================

  _attachDocumentTracking() {
    const accordions = document.querySelectorAll('.document-accordion');
    accordions.forEach(acc => {
      const docId = acc.dataset.docId;
      if (!docId) return;
      acc.addEventListener('toggle', () => {
        if (acc.open) {
          if (this.tracker) this.tracker.documentOpened(docId);
        } else {
          if (this.tracker) this.tracker.documentClosed(docId);
        }
      });
    });
  }

  // ============================================================
  // RENDERING
  // ============================================================

  renderPage(page) {
    const showDocs = this.config.showDocumentsPanel &&
      this.config.documentsPanelPages &&
      this.config.documentsPanelPages.includes(page.id);

    let innerHtml = '';
    switch (page.type) {
      case 'intro':      innerHtml = this.renderIntro(page); break;
      case 'consent':    innerHtml = this.renderConsent(page); break;
      case 'form':       innerHtml = this.renderForm(page); break;
      case 'info':       innerHtml = this.renderInfo(page); break;
      case 'review':     innerHtml = this.renderReview(page); break;
      case 'upload':     innerHtml = this.renderUpload(page); break;
      case 'completion': innerHtml = this.renderCompletion(page); break;
    }

    let html = '';
    if (showDocs) {
      html = `<div class="page-content page-content--with-docs">
        <div class="page-content__main">${innerHtml}</div>
        <div class="page-content__docs">${this.config.documentsPanelHtml || ''}</div>
      </div>`;
    } else {
      html = `<div class="page-content">${innerHtml}</div>`;
    }

    this.container.innerHTML = html;
    this._attachPageListeners(page);

    // Attach document tracking after DOM is ready
    if (showDocs) this._attachDocumentTracking();
  }

  renderIntro(page) {
    return `
      <div class="gov-main__two-thirds">
        ${page.caption ? `<span class="gov-caption-l">${page.caption}</span>` : ''}
        <h1 class="gov-heading-xl">${page.title}</h1>
        ${page.body ? `<div>${page.body}</div>` : ''}
        ${page.infoItems ? `
          <h2 class="gov-heading-m">You will need:</h2>
          <ul class="gov-list gov-list--bullet">
            ${page.infoItems.map(item => `<li>${item}</li>`).join('')}
          </ul>` : ''}
        ${page.warningText ? `
          <div class="gov-warning-text">
            <span class="gov-warning-text__icon">!</span>
            <span>${page.warningText}</span>
          </div>` : ''}
        <button class="gov-button gov-button--start" id="btn-next">
          ${page.buttonText || 'Start now'}
        </button>
      </div>`;
  }

  renderConsent(page) {
    return `
      <div class="gov-main__two-thirds">
        <h1 class="gov-heading-l">${page.title}</h1>
        <div class="gov-inset-text">${page.body}</div>
        <div class="gov-form-group" id="group-consent">
          <div class="gov-checkboxes__item">
            <input class="gov-checkboxes__input" id="consent" name="consent" type="checkbox" value="yes">
            <label class="gov-checkboxes__label" for="consent">
              ${page.consentLabel || 'I agree to participate in this study'}
            </label>
          </div>
        </div>
        <button class="gov-button" id="btn-consent" disabled>${page.buttonText || 'Continue'}</button>
      </div>`;
  }

  renderForm(page) {
    return `
      <div class="gov-main__two-thirds gov-form-container">
        ${page.section ? `<span class="gov-caption-l">${page.section}</span>` : ''}
        ${page.caption ? `<span class="gov-caption-l">${page.caption}</span>` : ''}
        <h1 class="gov-heading-l">${page.title}</h1>
        ${page.description ? `<p class="gov-body">${page.description}</p>` : ''}
        ${page.body ? `<div>${page.body}</div>` : ''}
        ${page.hint ? `<div class="gov-inset-text">${page.hint}</div>` : ''}
        ${page.fields.map(field => this.renderField(field)).join('')}
        <div style="display: flex; gap: 15px; margin-top: 40px;">
          ${page.allowBack ? `<button class="gov-button gov-button--secondary" id="btn-back">Back</button>` : ''}
          <button class="gov-button" id="btn-next">${page.buttonText || 'Continue'}</button>
        </div>
      </div>`;
  }

  renderField(field) {
    const existingValue = this.formData[field.name] || '';
    let html = `<div class="gov-form-group" id="group-${field.name}">`;

    switch (field.type) {
      case 'text':
      case 'email':
      case 'tel':
      case 'number': {
        const wc = field.width ? `gov-input--width-${field.width.replace('_', '-')}` : (field.widthClass || '');
        html += `
          <label class="gov-label" for="${field.name}">${field.label}</label>
          ${field.hint ? `<span class="gov-hint">${field.hint}</span>` : ''}
          <input class="gov-input ${wc}"
            type="${field.type === 'number' ? 'text' : field.type}"
            id="${field.name}" name="${field.name}"
            value="${existingValue}"
            autocomplete="${field.autocomplete || 'off'}"
            ${field.maxLength ? `maxlength="${field.maxLength}"` : ''}
            ${field.placeholder ? `placeholder="${field.placeholder}"` : ''}
            ${field.type === 'number' ? 'inputmode="numeric"' : ''}>`;
        break;
      }

      case 'textarea':
        html += `
          <label class="gov-label" for="${field.name}">${field.label}</label>
          ${field.hint ? `<span class="gov-hint">${field.hint}</span>` : ''}
          <textarea class="gov-textarea" id="${field.name}" name="${field.name}"
            rows="${field.rows || 5}">${existingValue}</textarea>`;
        break;

      case 'select':
        html += `
          <label class="gov-label" for="${field.name}">${field.label}</label>
          ${field.hint ? `<span class="gov-hint">${field.hint}</span>` : ''}
          <select class="gov-select" id="${field.name}" name="${field.name}">
            <option value="">Select an option</option>
            ${field.options.map(opt => {
              const val = typeof opt === 'string' ? opt : opt.value;
              const label = typeof opt === 'string' ? opt : opt.label;
              return `<option value="${val}" ${existingValue === val ? 'selected' : ''}>${label}</option>`;
            }).join('')}
          </select>`;
        break;

      case 'radio':
        html += `
          <fieldset>
            <legend class="gov-label">${field.label}</legend>
            ${field.hint ? `<span class="gov-hint">${field.hint}</span>` : ''}
            <div class="gov-radios">
              ${field.options.map((opt, i) => {
                const val = typeof opt === 'string' ? opt : opt.value;
                const label = typeof opt === 'string' ? opt : opt.label;
                const hint = typeof opt === 'object' ? opt.hint : null;
                return `
                  <div class="gov-radios__item">
                    <input class="gov-radios__input" type="radio"
                      name="${field.name}" id="${field.name}_${i}" value="${val}"
                      ${existingValue === val ? 'checked' : ''}>
                    <div>
                      <label class="gov-radios__label" for="${field.name}_${i}">${label}</label>
                      ${hint ? `<span class="gov-hint">${hint}</span>` : ''}
                    </div>
                  </div>`;
              }).join('')}
            </div>
          </fieldset>`;
        break;

      case 'checkbox':
        html += `
          <fieldset>
            <legend class="gov-label">${field.label}</legend>
            ${field.hint ? `<span class="gov-hint">${field.hint}</span>` : ''}
            ${field.options.map((opt, i) => {
              const val = typeof opt === 'string' ? opt : opt.value;
              const label = typeof opt === 'string' ? opt : opt.label;
              const isChecked = Array.isArray(existingValue) && existingValue.includes(val);
              return `
                <div class="gov-checkboxes__item">
                  <input class="gov-checkboxes__input" type="checkbox"
                    name="${field.name}" id="${field.name}_${i}" value="${val}"
                    ${isChecked ? 'checked' : ''}>
                  <label class="gov-checkboxes__label" for="${field.name}_${i}">${label}</label>
                </div>`;
            }).join('')}
          </fieldset>`;
        break;

      case 'date_group': {
        const parts = existingValue ? existingValue.split('/') : ['', '', ''];
        html += `
          <fieldset>
            <legend class="gov-label">${field.label}</legend>
            ${field.hint ? `<span class="gov-hint">${field.hint}</span>` : ''}
            <div class="gov-date-input">
              <div class="gov-date-input__item">
                <label class="gov-date-input__label" for="${field.name}_day">Day</label>
                <input class="gov-input gov-input--width-2" type="text"
                  id="${field.name}_day" name="${field.name}_day"
                  value="${parts[0]}" maxlength="2" inputmode="numeric">
              </div>
              <div class="gov-date-input__item">
                <label class="gov-date-input__label" for="${field.name}_month">Month</label>
                <input class="gov-input gov-input--width-2" type="text"
                  id="${field.name}_month" name="${field.name}_month"
                  value="${parts[1]}" maxlength="2" inputmode="numeric">
              </div>
              <div class="gov-date-input__item">
                <label class="gov-date-input__label" for="${field.name}_year">Year</label>
                <input class="gov-input gov-input--width-4" type="text"
                  id="${field.name}_year" name="${field.name}_year"
                  value="${parts[2]}" maxlength="4" inputmode="numeric">
              </div>
            </div>
          </fieldset>`;
        break;
      }

      case 'file':
        html += `
          <label class="gov-label" for="${field.name}">${field.label}</label>
          ${field.hint ? `<span class="gov-hint">${field.hint}</span>` : ''}
          <input class="gov-file-upload" type="file" id="${field.name}" name="${field.name}"
            ${field.accept ? `accept="${field.accept}"` : ''}>`;
        break;
    }

    html += '</div>';
    return html;
  }

  renderInfo(page) {
    return `
      <div class="gov-main__two-thirds">
        ${page.section ? `<span class="gov-caption-l">${page.section}</span>` : ''}
        ${page.caption ? `<span class="gov-caption-l">${page.caption}</span>` : ''}
        <h1 class="gov-heading-l">${page.title}</h1>
        ${page.body ? `<div>${page.body}</div>` : ''}
        ${page.customHtml ? page.customHtml : ''}
        ${page.insetText ? `<div class="gov-inset-text">${page.insetText}</div>` : ''}
        <div style="display: flex; gap: 15px; margin-top: 40px;">
          ${page.allowBack ? `<button class="gov-button gov-button--secondary" id="btn-back">Back</button>` : ''}
          <button class="gov-button" id="btn-next">${page.buttonText || 'Continue'}</button>
        </div>
      </div>`;
  }

  renderReview(page) {
    let sectionsHtml = '';
    if (page.sections) {
      page.sections.forEach(section => {
        sectionsHtml += `<h2 class="gov-heading-m">${section.title}</h2><dl class="gov-summary-list">`;
        section.fields.forEach(fieldName => {
          const def = this._findFieldDef(fieldName);
          const val = this.formData[fieldName] || '\u2014';
          const disp = Array.isArray(val) ? val.join(', ') : val;
          sectionsHtml += `
            <div class="gov-summary-list__row">
              <dt class="gov-summary-list__key">${def ? def.label : fieldName}</dt>
              <dd class="gov-summary-list__value">${disp}</dd>
            </div>`;
        });
        sectionsHtml += `</dl>`;
      });
    }
    return `
      <div class="gov-main__two-thirds">
        <h1 class="gov-heading-l">${page.title}</h1>
        <p class="gov-body">${page.description || 'Check your answers before submitting your application.'}</p>
        ${sectionsHtml}
        ${page.declaration ? `<h2 class="gov-heading-m">Declaration</h2><div class="gov-inset-text">${page.declaration}</div>` : ''}
        <div class="gov-warning-text">
          <span class="gov-warning-text__icon">!</span>
          <span>By submitting this application, you confirm that the information you have provided is correct to the best of your knowledge.</span>
        </div>
        <button class="gov-button" id="btn-next">${page.buttonText || 'Accept and submit'}</button>
      </div>`;
  }

  renderUpload(page) {
    return `
      <div class="gov-main__two-thirds">
        ${page.caption ? `<span class="gov-caption-l">${page.caption}</span>` : ''}
        <h1 class="gov-heading-l">${page.title}</h1>
        ${page.description ? `<p class="gov-body">${page.description}</p>` : ''}
        ${page.documents ? `
          <h2 class="gov-heading-m">Required documents</h2>
          <ul class="gov-list gov-list--bullet">
            ${page.documents.map(d => `<li>${d}</li>`).join('')}
          </ul>` : ''}
        ${(page.fields || []).map(field => this.renderField(field)).join('')}
        <div style="display: flex; gap: 15px; margin-top: 40px;">
          ${page.allowBack ? `<button class="gov-button gov-button--secondary" id="btn-back">Back</button>` : ''}
          <button class="gov-button" id="btn-next">${page.buttonText || 'Continue'}</button>
        </div>
      </div>`;
  }

  renderCompletion(page) {
    const redirectUrl = this.config.prolificCompletionUrl || page.prolificRedirect || null;
    return `
      <div class="gov-main__two-thirds" style="margin-top: 30px;">
        <h1 class="gov-heading-l">${page.title}</h1>
        ${page.body || ''}
        ${page.whatHappensNext ? `
          <h2 class="gov-heading-m">What happens next</h2>
          <p class="gov-body">${page.whatHappensNext}</p>` : ''}
        ${redirectUrl ? `
          <a href="${redirectUrl}" class="gov-button" role="button" id="btn-prolific">${page.buttonText || 'Return to Prolific'}</a>` : `
          <p class="gov-body"><strong>You may now close this window.</strong></p>`}
      </div>`;
  }

  _findFieldDef(fieldName) {
    for (const page of this.pages) {
      if (page.fields) {
        const f = page.fields.find(f => f.name === fieldName);
        if (f) return f;
      }
    }
    return null;
  }

  _generateReference() {
    return 'HDJ2123F';
  }

  _attachPageListeners(page) {
    const nextBtn = document.getElementById('btn-next');
    if (nextBtn) nextBtn.addEventListener('click', () => this.nextPage());

    const backBtn = document.getElementById('btn-back');
    if (backBtn) backBtn.addEventListener('click', () => this.previousPage());

    const consentBox = document.getElementById('consent');
    const consentBtn = document.getElementById('btn-consent');
    if (consentBox && consentBtn) {
      consentBox.addEventListener('change', () => { consentBtn.disabled = !consentBox.checked; });
      consentBtn.addEventListener('click', () => {
        if (consentBox.checked) {
          // Record consent server-side
          if (this.tracker && this.tracker.sessionId) {
            fetch('/api/session/consent', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ session_id: this.tracker.sessionId }),
            }).catch(() => {});
          }
          this.nextPage();
        }
      });
    }

    if (page.type === 'completion' && this.tracker) {
      this.tracker.completeSession();
    }
  }
}

window.ProcedureEngine = ProcedureEngine;
