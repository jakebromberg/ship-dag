// wave-epic.mjs — file each wave of an epic run as its own sub-epic.
//
// On an `epic#N` run, the wave the skill is about to ship becomes a native
// sub-issue of the epic, labelled `ship-dag-wave` and titled
// `<epic title> — wave K`, with the wave's issues re-parented under it. The
// epic's history then reads wave by wave in GitHub's sub-issue tree.
//
// Rules (the plan lives in jakebromberg/ship-dag#120):
//  - Only the epic's own same-repo children move. An issue under an
//    intermediate epic, or in another repo, keeps its parent and is listed in
//    the body instead.
//  - Which issues go back to the epic at close is read from live state, never
//    from outcomes: every OPEN child of the wave is returned. A merged issue was
//    closed by its PR, so it stays.
//  - A wave is closed only when every return succeeded. A stuck return leaves it
//    open, which the fetch guard in plan-waves.mjs and the next sweep cover.
//  - The body never carries dependency prose: `fetchSpec` reads a container's
//    body for edges and expands them onto every member.
//
// `runGh` is injected, as in plan-waves.mjs, so tests drive a fake `gh`.

import { listSubIssues, hasWaveLabel, WAVE_LABEL } from './sub-issues.mjs';

const WAVE_TITLE = / — wave (\d+)$/;

/** `owner/repo#N`, `#N` or `N` → `owner/repo#N`, a bare number qualified to `repo`. */
export function qualifyRef(ref, repo) {
  const m = String(ref).trim().match(/^(?:([\w.-]+\/[\w.-]+))?#?(\d+)$/);
  if (!m) throw new Error(`not an issue ref: ${JSON.stringify(ref)}`);
  return `${m[1] || repo}#${m[2]}`;
}

const numberOf = (ref) => Number(ref.slice(ref.lastIndexOf('#') + 1));
const refOfNode = (node, repo) => `${(node.repository && node.repository.nameWithOwner) || repo}#${node.number}`;
const shortRef = (ref, repo) => (ref.startsWith(`${repo}#`) ? `#${numberOf(ref)}` : ref);

/**
 * What a new wave sub-epic looks like, before any GitHub write. Pure.
 *
 * @param {{repo:string, epic:number, epicTitle:string, existingWaveCount:number,
 *          refs:string[], epicChildren:Set<string>}} input
 *   `refs` are qualified; `epicChildren` holds the epic's same-repo child refs.
 * @returns {{wave:number, title:string, move:string[], listed:string[], body:string}}
 */
export function planWaveEpic({ repo, epic, epicTitle, existingWaveCount, refs, epicChildren }) {
  const wave = existingWaveCount + 1;
  const move = refs.filter((r) => epicChildren.has(r));
  const listed = refs.filter((r) => !epicChildren.has(r));
  const lines = [
    `Wave ${wave} of #${epic}, filed by ship-dag. It closes when the wave's merge queue finishes; `
      + `any issue that did not merge goes back to #${epic}.`,
    '',
    ...refs.map((r) => `- [ ] ${shortRef(r, repo)}`),
  ];
  if (listed.length) {
    lines.push('', 'Wave members that stay under their own parent:', '',
      ...listed.map((r) => `- ${shortRef(r, repo)}`));
  }
  return { wave, title: `${epicTitle} — wave ${wave}`, move, listed, body: `${lines.join('\n')}\n` };
}

function issueId(repo, ref, runGh) {
  return String(runGh(['api', `repos/${repo}/issues/${numberOf(ref)}`, '--jq', '.id'])).trim();
}

/** Re-parent `ref` under `parent` (both in `repo`). Returns an error message, or null on success. */
function reparent(repo, parent, ref, runGh) {
  try {
    runGh(['api', '-X', 'POST', `repos/${repo}/issues/${parent}/sub_issues`,
      '-F', `sub_issue_id=${issueId(repo, ref, runGh)}`, '-F', 'replace_parent=true']);
    return null;
  } catch (err) {
    return err.message;
  }
}

/**
 * Open (or resume) the sub-epic for one wave and move its issues under it.
 * Idempotent: an open wave sub-epic already holding any of `refs` is reused,
 * and so is an unattached one carrying this wave's exact title (a session that
 * died between creating and attaching it). The sub-epic is attached to the epic
 * before any issue moves, so a session that dies mid-move leaves one the next
 * call finds.
 *
 * @param {{repo:string, epic:number, refs:string[]}} input
 * @param {(argv:string[]) => string} runGh
 * @param {(m:string) => void} [warn]
 * @returns {{number:number, wave:number, moved:string[], listed:string[], reused:boolean}}
 */
export function openWaveEpic({ repo, epic, refs: rawRefs }, runGh, warn = (m) => console.error(m)) {
  const refs = rawRefs.map((r) => qualifyRef(r, repo));
  const wanted = new Set(refs);
  const subs = listSubIssues({ number: epic, repo }, runGh);
  const waves = subs.filter(hasWaveLabel);
  const epicChildren = new Set(subs.filter((s) => !hasWaveLabel(s) && refOfNode(s, repo).startsWith(`${repo}#`))
    .map((s) => refOfNode(s, repo)));

  let number = null;
  let wave = null;
  let reused = true;
  let already = new Set();
  for (const w of waves.filter((s) => s.state === 'OPEN')) {
    const kids = listSubIssues({ number: w.number, repo }, runGh).map((k) => refOfNode(k, repo));
    if (kids.some((k) => wanted.has(k))) {
      number = w.number;
      already = new Set(kids);
      break;
    }
  }

  const epicTitle = String(runGh(['issue', 'view', String(epic), '-R', repo, '--json', 'title', '--jq', '.title'])).trim();
  const plan = planWaveEpic({ repo, epic, epicTitle, existingWaveCount: waves.length, refs, epicChildren });
  if (number !== null) {
    const title = String(runGh(['issue', 'view', String(number), '-R', repo, '--json', 'title', '--jq', '.title'])).trim();
    const m = title.match(WAVE_TITLE);
    wave = m ? Number(m[1]) : null;
  } else {
    const found = JSON.parse(runGh(['issue', 'list', '-R', repo, '--label', WAVE_LABEL, '--state', 'open',
      '--search', `in:title "${plan.title}"`, '--json', 'number,title']));
    const hit = found.find((i) => i.title === plan.title);
    let id;
    if (hit) {
      number = hit.number;
      id = issueId(repo, `${repo}#${hit.number}`, runGh);
    } else {
      runGh(['label', 'create', WAVE_LABEL, '-R', repo, '--color', 'BFD4F2',
        '--description', 'One wave of a ship-dag epic run', '--force']);
      const created = JSON.parse(runGh(['api', `repos/${repo}/issues`, '-f', `title=${plan.title}`,
        '-f', `body=${plan.body}`, '-f', `labels[]=${WAVE_LABEL}`]));
      number = created.number;
      id = created.id;
      reused = false;
    }
    runGh(['api', '-X', 'POST', `repos/${repo}/issues/${epic}/sub_issues`, '-F', `sub_issue_id=${id}`]);
    wave = plan.wave;
  }

  const moved = [];
  const listed = plan.listed.filter((r) => !already.has(r));
  for (const ref of refs) {
    if (already.has(ref)) { moved.push(ref); continue; }
    if (!plan.move.includes(ref)) continue;
    const err = reparent(repo, number, ref, runGh);
    if (err) {
      warn(`warning: could not move ${ref} under wave sub-epic #${number} (${err}); it stays under #${epic}`);
      listed.push(ref);
    } else {
      moved.push(ref);
    }
  }
  return { number, wave, moved, listed, reused };
}

/**
 * Close one wave sub-epic: return every open child to the epic, post one comment
 * with the per-issue table, and close the sub-epic only if every return
 * succeeded. A closed wave with no open child is a no-op.
 *
 * @param {{repo:string, epic:number, waveEpic:number,
 *          outcomes?:Record<string,{finalState?:string, failureReason?:string, pr?:number|string}>}} input
 *   `outcomes` only fills the PR and reason columns; it never decides a return.
 * @param {(argv:string[]) => string} runGh
 * @param {{comment?:string}} [opts]  `comment` replaces the table's heading line.
 * @returns {{closed:boolean, returned:string[], stuck:string[], noop:boolean}}
 */
export function closeWaveEpic({ repo, epic, waveEpic, outcomes = {} }, runGh, { comment } = {}) {
  const view = JSON.parse(runGh(['issue', 'view', String(waveEpic), '-R', repo, '--json', 'state,labels']));
  if (!(view.labels || []).some((l) => l.name === WAVE_LABEL)) {
    throw new Error(`#${waveEpic} in ${repo} is not labelled ${WAVE_LABEL}; refusing to touch it`);
  }
  const kids = listSubIssues({ number: waveEpic, repo }, runGh);
  const open = kids.filter((k) => k.state === 'OPEN');
  if (view.state === 'CLOSED' && !open.length) return { closed: false, returned: [], stuck: [], noop: true };

  const returned = [];
  const stuck = [];
  for (const k of open) {
    const ref = refOfNode(k, repo);
    (reparent(repo, epic, ref, runGh) ? stuck : returned).push(ref);
  }

  const known = Object.fromEntries(Object.entries(outcomes).map(([r, o]) => [qualifyRef(r, repo), o]));
  const rows = kids.map((k) => {
    const ref = refOfNode(k, repo);
    const o = known[ref] || {};
    let state = 'closed';
    if (returned.includes(ref)) state = `returned to #${epic}`;
    if (stuck.includes(ref)) state = 'stuck (return failed)';
    return `| ${shortRef(ref, repo)} | ${state} | ${o.pr ? `#${o.pr}` : '—'} | ${o.failureReason || o.finalState || ''} |`;
  });
  const text = [comment || `Wave closed by ship-dag.`, '', '| Issue | State | PR | Note |', '|---|---|---|---|', ...rows,
    ...(stuck.length ? ['', `Left open: ${stuck.length} issue(s) could not be returned to #${epic}.`] : [])].join('\n');
  runGh(['issue', 'comment', String(waveEpic), '-R', repo, '--body', text]);

  if (stuck.length || view.state === 'CLOSED') return { closed: false, returned, stuck, noop: false };
  runGh(['issue', 'close', String(waveEpic), '-R', repo, '--reason', 'completed']);
  return { closed: true, returned, stuck, noop: false };
}
