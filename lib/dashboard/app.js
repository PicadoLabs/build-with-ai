/* Browser script for `build-with-ai ui`. Every value from the project is
 * inserted with textContent, never innerHTML, because decisions and history
 * come from AI responses. */
(function () {
  'use strict';

  const POLL_INTERVAL_MS = 5000;
  const renderers = [];
  let lastPayload = '';

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'text') node.textContent = value;
      else if (key === 'className') node.className = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of [].concat(children || [])) {
      if (child) node.append(child);
    }
    return node;
  }

  function formatDate(iso) {
    if (!iso) return 'Unknown';
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
  }

  function showError(message) {
    const banner = document.getElementById('error');
    banner.textContent = message || '';
    banner.hidden = !message;
  }

  function renderHeader(data) {
    const { status } = data;
    document.getElementById('project-name').textContent = status.projectName || 'Untitled project';
    document.title = `${status.projectName || 'Project'} - build-with-ai`;
    const meta = [status.templateTitle, status.experienceLevel, data.branchScoped ? 'branch-scoped' : null]
      .filter(Boolean)
      .join(' / ');
    document.getElementById('project-meta').textContent = meta;
  }

  function renderProgress(data) {
    const { status } = data;
    const bar = document.getElementById('progress-bar');
    bar.setAttribute('aria-valuenow', String(status.progressPercent));
    document.getElementById('progress-fill').style.width = `${status.progressPercent}%`;

    const stats = [
      ['Completed', `${status.completedCount} of ${status.totalSteps} steps (${status.progressPercent}%)`],
      ['Current step', status.currentStep > status.totalSteps ? 'Finished' : `Step ${status.currentStep}`],
      ['Export readiness', status.exportReady ? 'Ready' : 'In progress'],
      ['Started', formatDate(status.startedAt)],
      ['Last updated', formatDate(status.updatedAt)]
    ];
    document
      .getElementById('progress-stats')
      .replaceChildren(
        ...stats.map(([label, value]) => el('div', {}, [el('dt', { text: label }), el('dd', { text: value })]))
      );
  }

  function renderPhases(data) {
    const tree = document.getElementById('phase-tree');
    const openPhases = new Set(
      Array.from(tree.querySelectorAll('details[open]')).map((node) => node.getAttribute('data-phase'))
    );
    const firstRender = tree.childElementCount === 0;

    if (data.phases.length === 0) {
      tree.replaceChildren(el('p', { className: 'muted', text: 'The project template could not be loaded.' }));
      return;
    }

    tree.replaceChildren(
      ...data.phases.map((phase) => {
        const done = phase.completedCount === phase.total;
        const hasCurrent = phase.steps.some((step) => step.status === 'current');
        const open = firstRender ? hasCurrent : openPhases.has(phase.name);
        const badgeClass = done ? 'badge badge-success' : hasCurrent ? 'badge badge-accent' : 'badge';

        return el('details', { className: 'phase', 'data-phase': phase.name, open }, [
          el('summary', {}, [
            el('span', { text: phase.name }),
            el('span', { className: badgeClass, text: `${phase.completedCount}/${phase.total}` })
          ]),
          el(
            'ol',
            { className: 'phase-steps' },
            phase.steps.map((step) =>
              el('li', { className: `step step-${step.status}`, title: step.status }, [
                el('span', { className: 'step-marker', 'aria-hidden': 'true' }),
                el('span', {}, [
                  el('span', { className: 'step-title', text: `${step.number}. ${step.title}` }),
                  step.status === 'current' ? el('span', { className: 'badge badge-accent', text: 'current' }) : null,
                  step.goal ? el('span', { className: 'step-goal', text: step.goal }) : null
                ])
              ])
            )
          )
        ]);
      })
    );
  }

  function formatValue(value) {
    if (Array.isArray(value)) return value.map((item) => formatValue(item)).join(', ');
    if (value !== null && typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  let decisionRows = [];

  function renderDecisionList() {
    const query = document.getElementById('decision-search').value.trim().toLowerCase();
    const phase = document.getElementById('decision-phase').value;
    const matches = decisionRows.filter((row) => {
      if (phase === '__none__' ? row.phase !== null : phase && row.phase !== phase) return false;
      if (!query) return true;
      return `${row.key} ${formatValue(row.value)}`.toLowerCase().includes(query);
    });

    document.getElementById('decision-count').textContent = `${matches.length} of ${decisionRows.length}`;
    const body = document.getElementById('decision-rows');
    if (matches.length === 0) {
      const message = decisionRows.length === 0 ? 'No decisions recorded yet.' : 'No decisions match.';
      body.replaceChildren(el('tr', {}, el('td', { colspan: '3', className: 'muted', text: message })));
      return;
    }
    body.replaceChildren(
      ...matches.map((row) =>
        el('tr', {}, [
          el('td', {}, el('code', { text: row.key })),
          el('td', { className: 'decision-value', text: formatValue(row.value) }),
          el('td', {
            className: 'muted small',
            text: row.step ? `Step ${row.step} / ${row.phase}` : 'Manual'
          })
        ])
      )
    );
  }

  function renderDecisions(data) {
    decisionRows = data.decisions;
    const select = document.getElementById('decision-phase');
    const selected = select.value;
    const phases = data.phases.map((phase) => phase.name).filter((name) => decisionRows.some((r) => r.phase === name));
    const options = [el('option', { value: '', text: 'All phases' })].concat(
      phases.map((name) => el('option', { value: name, text: name }))
    );
    if (decisionRows.some((row) => row.phase === null)) {
      options.push(el('option', { value: '__none__', text: 'Manual / other' }));
    }
    select.replaceChildren(...options);
    select.value = Array.from(select.options).some((option) => option.value === selected) ? selected : '';
    renderDecisionList();
  }

  document.getElementById('decision-search').addEventListener('input', renderDecisionList);
  document.getElementById('decision-phase').addEventListener('change', renderDecisionList);

  renderers.push(renderHeader, renderProgress, renderPhases, renderDecisions);

  async function load({ force = false } = {}) {
    try {
      const response = await fetch('/api/project', { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `Request failed with status ${response.status}`);

      const { generatedAt, ...rest } = body;
      const payload = JSON.stringify(rest);
      document.getElementById('updated-at').textContent = `Synced ${new Date(generatedAt).toLocaleTimeString()}`;
      showError('');
      if (!force && payload === lastPayload) return;
      lastPayload = payload;
      for (const render of renderers) render(body);
    } catch (error) {
      showError(`Could not load project data: ${error.message}`);
    }
  }

  document.getElementById('refresh').addEventListener('click', () => load({ force: true }));
  load();
  setInterval(() => {
    if (!document.hidden) load();
  }, POLL_INTERVAL_MS);
})();
