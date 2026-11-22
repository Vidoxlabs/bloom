export function teamView({ $, node, request, error, state }) {
  let mode = 'source', latest = 0, boundTeam = null;
  const checked = new Set();
  const usageByActor = new Map();
  const path = (id, suffix = '') => '/api/teams/' + id + suffix;
  function reset() {
    boundTeam = null;
    latest++;
    checked.clear();
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
  }
  function configure() {
    const team = $('kind').value === 'team';
    $('team-setup').hidden = !team;
    $('direct-setup').hidden = team;
    $('create-session').textContent = team ? 'Create team' : 'Create session';
    $('head-name').required = team;
  }
  function render(detail) {
    const { team, members, notes, files } = detail;
    const roster = [{ name: team.name, charter: team.charter, stage: 'head' }, ...members];
    const selected = $('recipient').value;
    $('recipient').replaceChildren(...roster.map(agent => new Option(agent.name, agent.name)));
    if (roster.some(a => a.name === selected)) $('recipient').value = selected;
    $('members').replaceChildren(...roster.map(a => {
      const li = node('li'), fold = node('details');
      const label = node('summary', a.name + ' · ' + a.stage);
      fold.append(label, node('p', a.charter), ...(a.voice ? [node('p', a.voice, 'hint')] : [])); li.append(fold); return li;
    }));
    $('files').replaceChildren(...files.map(file => {
      const li = node('li'), wrap = node('label'), check = node('input');
      check.type = 'checkbox'; check.checked = checked.has(file.id);
      check.onchange = () => {
        if (!check.checked) checked.delete(file.id);
        else if (checked.size < 6) checked.add(file.id);
        else { check.checked = false; error('Attach up to six files at a time.'); }
      };
      wrap.append(check, document.createTextNode(file.title));
      const open = node('button', 'Open', 'text-button');
      open.onclick = () => read(file.id).catch(e => error(e.message));
      li.append(wrap, open); return li;
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
    $('reader-lineage').textContent = [file.author, file.source_url, file.parents.length + ' input files', 'SHA-256 ' + file.sha256].filter(Boolean).join(' · ');
    $('download').href = path(id, '/files/' + fileId + '?download');
    $('reader').showModal();
  }
  function openEditor(kind) {
    mode = kind;
    const source = kind === 'source';
    $('editor-form').reset();
    $('editor-title').textContent = source ? 'Add a shared source' : 'Save a team note';
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
    if (type === 'team.recall') $('tools').append(node('li', data.actor + ' · memory ' + (data.hit ? 'cache hit' : 'read') + ' · ' + data.count + ' notes'));
    if (type === 'team.usage') {
      const u = data.usage;
      usageByActor.set(data.calls, data.actor + ' · ' + (data.model || 'Default model') + ' · input ' + display(u.input) + ' · output ' + display(u.output) + ' · cache read ' + display(u.cacheRead) + ' · write ' + display(u.cacheWrite) + ' · USD ' + (u.costUSD == null ? 'unreported' : String(u.costUSD)));
      const details = node('details'), title = data.calls + '/' + data.limit + ' model calls · ' + display(data.measuredTotal) + ' measured tokens' + (data.incomplete ? ' (partial)' : '');
      details.append(node('summary', title), ...[...usageByActor.values()].map(v => node('p', v, 'hint')));
      $('usage').replaceChildren(details);
    }
  }
  return { reset, configure, refresh, read, activity,
    target: () => ({ ...(boundTeam && $('recipient').selectedIndex > 0 ? { to: $('recipient').value } : {}), files: [...checked] }),
    create: () => request('/api/teams', { name: $('head-name').value, charter: $('charter').value, model: $('team-model').value,
      callLimit: Number($('call-limit').value), tokenLimit: $('token-limit').value ? Number($('token-limit').value) : null }) };
}
