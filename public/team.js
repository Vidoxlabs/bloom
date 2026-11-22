export function teamView({ $, node, request, error, state }) {
  let mode = 'source', latest = 0, boundTeam = null;
  const checked = new Set();
  let fileNames = new Map(), personas = [], editing = null;
  const usageByActor = new Map();
  const stageNames = { head: 'Head agent', research: 'Research', review: 'Review', assemble: 'Assemble', work: 'Work', verify: 'Check' };
  const path = (id, suffix = '') => '/api/teams/' + id + suffix;
  function reset() {
    boundTeam = null;
    latest++;
    checked.clear();
    fileNames.clear();
    usageByActor.clear();
    $('usage').replaceChildren();
    $('recipient').replaceChildren();
    $('members').replaceChildren();
    $('files').replaceChildren();
    $('notes').replaceChildren();
    const active = state.session?.adapter === 'team';
    $('team-inspector').hidden = !active;
    $('recipient-row').hidden = !active;
    $('prompt').placeholder = active ? 'Give your team a task' : 'Tell the agent what to work on';
    renderPersonas();
  }
  function renderPersonas() {
    const active = state.session?.adapter === 'team';
    $('personas').replaceChildren(...personas.map(persona => {
      const li = node('li', null, 'persona'), name = node('span', persona.name + ' · ' + (stageNames[persona.stage] ?? persona.stage));
      const actions = node('span', null, 'persona-actions'), add = node('button', 'Add to team', 'text-button'), edit = node('button', 'Edit', 'text-button');
      add.hidden = !active;
      add.setAttribute('aria-label', 'Add ' + persona.name + ' to team');
      edit.setAttribute('aria-label', 'Edit ' + persona.name);
      add.onclick = async () => {
        const id = state.session.id;
        try { const detail = await request(path(id, '/members'), { persona: persona.id }); if (state.session?.id === id) render(detail); }
        catch (e) { error(e.message); }
      };
      edit.onclick = () => openPersona(persona, persona.id);
      actions.append(add, edit); li.append(name, actions); return li;
    }));
  }
  async function loadPersonas() { personas = await request('/api/personas'); renderPersonas(); }
  function openPersona(persona = {}, id = null) {
    editing = id;
    $('persona-form').reset();
    $('persona-title').textContent = id ? 'Edit ' + persona.name : 'New persona';
    $('persona-name').value = persona.name ?? '';
    $('persona-charter').value = persona.charter ?? '';
    $('persona-voice').value = persona.voice ?? '';
    $('persona-stage').value = persona.stage && persona.stage !== 'head' ? persona.stage : 'research';
    $('persona-model').value = persona.model ?? '';
    $('persona-delete').hidden = !id;
    $('persona-error').textContent = '';
    $('persona-dialog').showModal();
  }
  function configure() {
    const team = $('kind').value === 'team';
    $('team-setup').hidden = !team;
    $('direct-setup').hidden = team;
    $('create-session').textContent = team ? 'Create team' : 'Create coding session';
    $('head-name').required = team;
  }
  function render(detail) {
    const { team, members, notes, files } = detail;
    const roster = [{ name: team.name, charter: team.charter, stage: 'head' }, ...members];
    fileNames = new Map(files.map(f => [f.id, f.title]));
    const selected = $('recipient').value;
    $('recipient').replaceChildren(...roster.map(agent => new Option(agent.name, agent.name)));
    if (roster.some(a => a.name === selected)) $('recipient').value = selected;
    $('members').replaceChildren(...roster.map(a => {
      const li = node('li'), fold = node('details');
      const label = node('summary', a.name + ' · ' + (stageNames[a.stage] ?? a.stage));
      fold.append(label, node('p', a.stage === 'head' ? 'VI · Team coordinator' : a.stage === 'verify' ? 'LA · Deterministic verification' : 'OAI · Model-backed specialist', 'hint'), node('p', a.charter), ...(a.voice ? [node('p', a.voice, 'hint')] : []), ...(a.model ? [node('p', a.model, 'hint')] : []));
      if (a.stage !== 'head') {
        const save = node('button', 'Save as persona', 'text-button');
        save.onclick = () => openPersona(a);
        fold.append(save);
      }
      li.append(fold); return li;
    }));
    // Group the newest revision of each file under its folder; top-level files come first.
    const grouped = [...files].sort((x, y) => (x.folder ?? '').localeCompare(y.folder ?? ''));
    let folder;
    $('files').replaceChildren(...grouped.flatMap(file => {
      const rows = [];
      if ((file.folder ?? null) !== folder) {
        folder = file.folder ?? null;
        if (folder) rows.push(node('li', folder, 'folder'));
      }
      const li = node('li'), wrap = node('label'), check = node('input');
      if (file.folder) li.className = 'in-folder';
      check.type = 'checkbox'; check.checked = checked.has(file.id);
      check.onchange = () => {
        if (!check.checked) checked.delete(file.id);
        else if (checked.size < 6) checked.add(file.id);
        else { check.checked = false; error('Attach up to six files at a time.'); }
      };
      const name = node('span', file.title);
      if (file.revision > 1) name.append(node('span', ' · v' + file.revision, 'revision'));
      wrap.append(check, name);
      const open = node('button', 'Open', 'text-button');
      open.onclick = () => read(file.id).catch(e => error(e.message));
      li.append(wrap, open); rows.push(li); return rows;
    }));
    $('notes').replaceChildren(...notes.map(note => {
      const li = node('li', note.text), forget = node('button', 'Forget', 'text-button');
      forget.onclick = async () => {
        const id = state.session.id;
        try { await request(path(id, '/notes/' + note.id), {}, 'DELETE'); await refresh(); }
        catch (e) { error(e.message); }
      };
      li.append(forget); return li;
    }));
  }
  async function refresh() {
    const id = state.session?.id, tick = ++latest;
    if (state.session?.adapter !== 'team') return;
    const detail = await request(path(id));
    if (state.session?.id !== id || tick !== latest) return;
    boundTeam = id;
    render(detail);
  }
  async function read(fileId) {
    const id = state.session.id;
    const file = await request(path(id, '/files/' + fileId));
    if (state.session.id !== id) return;
    $('reader-title').textContent = file.title;
    $('reader-body').textContent = file.text;
    $('reader-lineage').textContent = [file.author, file.folder, (file.history?.length ?? 0) > 1 ? 'Revision ' + file.revision : null, file.source_url,
      file.parents.length + ' input files', 'SHA-256 ' + file.sha256].filter(Boolean).join(' · ');
    const others = (file.history ?? []).filter(entry => entry.id !== file.id);
    $('reader-history-label').hidden = !others.length;
    $('reader-history').replaceChildren(...others.map(entry => {
      const row = node('li'), button = node('button', 'Revision ' + entry.revision + ' · ' + entry.title + ' · ' + entry.author, 'text-button');
      button.onclick = () => read(entry.id).catch(e => error(e.message));
      row.append(button); return row;
    }));
    $('download').href = path(id, '/files/' + fileId + '?download');
    $('reader-parents').replaceChildren(...file.parents.map(parent => {
      const row = node('li'), button = node('button', fileNames.get(parent) ?? 'Open input file', 'text-button');
      button.onclick = () => read(parent).catch(e => error(e.message));
      row.append(button); return row;
    }));
    if (!$('reader').open) $('reader').showModal();
  }
  function openEditor(kind) {
    mode = kind;
    const source = kind === 'source';
    $('editor-form').reset();
    $('editor-title').textContent = source ? 'Add a file' : 'Save a team note';
    $('source-name').hidden = $('source-address').hidden = !source;
    $('source-title').required = source;
    $('body-label').textContent = source ? 'Or paste text' : 'What should this team remember?';
    $('source-body').maxLength = source ? 16000 : 800;
    $('editor-error').textContent = '';
    $('editor').showModal();
  }
  $('editor-form').onsubmit = async event => {
    event.preventDefault();
    const id = state.session.id, button = event.submitter;
    button.disabled = true;
    try {
      const text = $('source-body').value.trim();
      if (mode === 'source') {
        const file = await request(path(id, '/sources'), { title: $('source-title').value, text, url: $('source-url').value.trim() });
        if (state.session?.id === id && checked.size < 6) checked.add(file.id);
      } else await request(path(id, '/notes'), { text });
      $('editor').close();
      await refresh();
    } catch (e) { $('editor-error').textContent = e.message; }
    finally { button.disabled = false; }
  };
  $('persona-form').onsubmit = async event => {
    event.preventDefault();
    const button = event.submitter, body = { name: $('persona-name').value, charter: $('persona-charter').value.trim(),
      voice: $('persona-voice').value.trim(), stage: $('persona-stage').value, model: $('persona-model').value.trim() };
    button.disabled = true;
    try {
      await request(editing ? '/api/personas/' + editing : '/api/personas', body, editing ? 'PUT' : 'POST');
      $('persona-dialog').close();
      await loadPersonas();
    } catch (e) { $('persona-error').textContent = e.message; }
    finally { button.disabled = false; }
  };
  $('persona-delete').onclick = async () => {
    if (!editing || !confirm('Delete ' + $('persona-name').value + ' from the library? Teams that already recruited it keep their copy.')) return;
    try { await request('/api/personas/' + editing, {}, 'DELETE'); $('persona-dialog').close(); await loadPersonas(); }
    catch (e) { $('persona-error').textContent = e.message; }
  };
  $('persona-close').onclick = () => $('persona-dialog').close();
  $('new-persona').onclick = () => openPersona();
  $('new-source').onclick = () => openEditor('source');
  $('new-note').onclick = () => openEditor('note');
  $('editor-close').onclick = () => $('editor').close();
  $('reader-close').onclick = () => $('reader').close();
  $('sample-brief').onclick = () => {
    $('prompt').value = 'Create a researcher to extract claims from the attached sources, a reviewer to check them, and an assembler to write a guide. Flag any evidence gaps.';
    $('prompt').focus();
  };
  $('kind').onchange = configure;
  const display = n => n == null ? 'unreported' : n.toLocaleString();
  function activity(type, data) {
    if (type === 'turn.started') { usageByActor.clear(); $('usage').replaceChildren(); }
    if (!type.startsWith('team.')) return;
    $('activity-empty').hidden = true;
    if (type === 'team.call') {
      const li = node('li', data.actor + ' · ' + (data.phase === 'plan' ? 'Planning' : 'Working'));
      $('plan').append(li);
    }
    if (type === 'team.recall') $('tools').append(node('li', data.actor + ' · notes ' + (data.hit ? 'reused' : 'loaded') + ' · ' + data.count + ' notes'));
    if (type === 'team.usage') {
      const u = data.usage;
      const line = data.actor + ' · ' + (data.model || 'Default model') + ' · input ' + display(u.input) + ' · output ' + display(u.output) + ' · cache read ' + display(u.cacheRead) + ' · write ' + display(u.cacheWrite) + ' · USD ' + (u.costUSD == null ? 'unreported' : String(u.costUSD));
      usageByActor.set(data.calls, { line, total: u.total });
      const records = [...usageByActor.values()];
      const tokens = records.some(record => Number.isSafeInteger(record.total) && record.total >= 0)
        ? display(data.measuredTotal) + ' measured tokens' + (data.incomplete ? ' (partial)' : '')
        : 'tokens unreported';
      const details = node('details');
      details.append(node('summary', data.calls + '/' + data.limit + ' model calls · ' + tokens), ...records.map(record => node('p', record.line, 'hint')));
      $('usage').replaceChildren(details);
    }
  }
  return { reset, configure, refresh, read, activity, loadPersonas,
    target: () => ({ ...(boundTeam && $('recipient').selectedIndex > 0 ? { to: $('recipient').value } : {}), files: [...checked] }),
    create: () => request('/api/teams', { name: $('head-name').value, charter: $('charter').value, model: $('team-model').value,
      callLimit: Number($('call-limit').value), tokenLimit: $('token-limit').value ? Number($('token-limit').value) : null }) };
}
