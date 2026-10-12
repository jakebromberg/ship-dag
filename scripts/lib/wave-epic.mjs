// wave-epic.mjs — file each wave of an epic run as its own sub-epic.
//
// On an `epic#N` run, the wave the skill is about to ship becomes a native
// sub-issue of the epic, labelled `ship-dag-wave` and titled
// `<epic title> — wave K`, with the wave's issues re-parented under it. The
// epic's history then reads wave by wave in GitHub's sub-issue tree.
//
// Rules (the plan lives in jakebromberg/ship-dag#120):
//  - Only the epic's own same-repo children move, plus any of this wave's refs
//    still under another open wave sub-epic of the epic (a lost session's or a
//    stuck return's), so two waves never share a sub-epic. An issue under an
//    intermediate epic, or in another repo, keeps its parent and is listed in
//    the body instead.
//  - Which issues go back to the epic at close is read from live state, never
//    from outcomes: every OPEN child of the wave is returned. A merged issue was
//    closed by its PR, so it stays.
//  - A wave is closed only when every return succeeded. A stuck return leaves it
//    open, which the fetch guard in plan-waves.mjs and the next sweep cover.
//  - Everything that can refuse does so before the first write, by throwing
//    `WaveEpicRefusal`. Any other throw happened partway, and since every
//    command is idempotent, the remedy is to run it again.
//  - The body never carries dependency prose: `fetchSpec` reads a container's
//    body for edges and expands them onto every member.
//
// `runGh` is injected, as in plan-waves.mjs, so tests drive a fake `gh`.

import { listSubIssues, hasWaveLabel, subIssueRepo, WAVE_LABEL } from './sub-issues.mjs';

const WAVE_TITLE = / — wave (\d+)$/;

/** A refusal raised before any GitHub write: the CLI exits 2, and nothing needs undoing. */
export class WaveEpicRefusal extends Error {}

/** `owner/repo#N`, `#N` or `N` → `owner/repo#N`, a bare number qualified to `repo`. */
export function qualifyRef(ref, repo) {
  const m = String(ref).trim().match(/^(?:([\w.-]+\/[\w.-]+))?#?(\d+)$/);
  if (!m) throw new WaveEpicRefusal(`not an issue ref: ${JSON.stringify(ref)}`);
  return `${m[1] || repo}#${m[2]}`;
}

// GitHub repo names are case-insensitive, and `--repo` is used as typed, so
// refs are compared by this key and displayed as given.
const keyOf = (ref) => ref.toLowerCase();
const sameRepo = (a, b) => a.toLowerCase() === b.toLowerCase();
const refOfNode = (node, repo) => `${subIssueRepo(node, repo)}#${node.number}`;
const shortRef = (ref, repo) => (keyOf(ref).startsWith(keyOf(`${repo}#`)) ? ref.slice(ref.lastIndexOf('#')) : ref);
const waveNumberOf = (title) => { const m = String(title || '').match(WAVE_TITLE); return m ? Number(m[1]) : null; };

/**
 * What a new wave sub-epic looks like, before any GitHub write. Pure.
 *
 * @param {{repo:string, epic:number, epicTitle:string, wave:number, refs:string[], movable:Set<string>}} input
 *   `refs` are qualified; `movable` holds the `keyOf` of every ref that may move.
 * @returns {{title:string, move:string[], listed:string[], body:string}}
 */
export function planWaveEpic({ repo, epic, epicTitle, wave, refs, movable }) {
  const move = refs.filter((r) => movable.has(keyOf(r)));
  const listed = refs.filter((r) => !movable.has(keyOf(r)));
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
  return { title: `${epicTitle} — wave ${wave}`, move, listed, body: `${lines.join('\n')}\n` };
}

/** POST one sub-issue (by REST id) under `parent` in `repo`. Returns an error message, or null on success. */
function attach(repo, parent, id, runGh, { replace = true } = {}) {
  try {
    runGh(['api', '-X', 'POST', `repos/${repo}/issues/${parent}/sub_issues`, '-F', `sub_issue_id=${id}`,
      ...(replace ? ['-F', 'replace_parent=true'] : [])]);
    return null;
  } catch (err) {
    return err.message;
  }
}

/**
 * Open the sub-epic for one wave and move its issues under it.
 *
 * Idempotent. It reuses an open wave sub-epic of the epic with no sub-issues (a
 * session that died after attaching it, before moving anything), or failing
 * that an open, unattached `ship-dag-wave` issue carrying this wave's exact
 * title (one that died between creating and attaching it). Otherwise it creates
 * one. The sub-epic is attached before any issue moves.
 *
 * @param {{repo:string, epic:number, refs:string[]}} input
 * @param {(argv:string[]) => string} runGh
 * @param {(m:string) => void} [warn]
 * @returns {{number:number, wave:number, moved:string[], listed:string[], reused:boolean}}
 */
export function openWaveEpic({ repo, epic, refs: rawRefs }, runGh, warn = (m) => console.error(m)) {
  const refs = rawRefs.map((r) => qualifyRef(r, repo));
  const subs = listSubIssues({ number: epic, repo }, runGh);
  const waves = subs.filter((s) => hasWaveLabel(s) && sameRepo(subIssueRepo(s, repo), repo));
  const openWaves = waves.filter((w) => w.state === 'OPEN');
  const empty = openWaves.find((w) => !(w.subIssuesSummary && w.subIssuesSummary.total > 0));

  // Every issue this wave may move, keyed for lookup, with the REST id the move needs.
  const movable = new Map();
  const addMovable = (node) => {
    if (sameRepo(subIssueRepo(node, repo), repo)) movable.set(keyOf(refOfNode(node, repo)), node.databaseId);
  };
  subs.filter((s) => !hasWaveLabel(s)).forEach(addMovable);
  for (const w of openWaves.filter((x) => x !== empty)) listSubIssues({ number: w.number, repo }, runGh).forEach(addMovable);

  let number;
  let wave;
  let reused = true;
  if (empty) {
    number = empty.number;
    wave = waveNumberOf(empty.title) || waves.length;
  } else {
    // After the highest wave number in a title, not just the count, so a wave
    // deleted or filed by hand never makes two waves share a number.
    wave = Math.max(waves.length, ...waves.map((w) => waveNumberOf(w.title) || 0)) + 1;
  }
  const epicTitle = String(runGh(['issue', 'view', String(epic), '-R', repo, '--json', 'title', '--jq', '.title'])).trim();
  const plan = planWaveEpic({ repo, epic, epicTitle, wave, refs, movable: new Set(movable.keys()) });

  if (!empty) {
    const attached = new Set(waves.map((w) => w.number));
    const orphans = JSON.parse(runGh(['issue', 'list', '-R', repo, '--label', WAVE_LABEL, '--state', 'open',
      '--limit', '200', '--json', 'number,title']))
      .filter((i) => i.title === plan.title && !attached.has(i.number));
    for (const o of orphans) {
      const id = String(runGh(['api', `repos/${repo}/issues/${o.number}`, '--jq', '.id'])).trim();
      // No replace_parent: one already under some other epic is not ours to take.
      if (!attach(repo, epic, id, runGh, { replace: false })) { number = o.number; break; }
    }
    if (number === undefined) {
      runGh(['label', 'create', WAVE_LABEL, '-R', repo, '--color', 'BFD4F2',
        '--description', 'One wave of a ship-dag epic run', '--force']);
      const created = JSON.parse(runGh(['api', `repos/${repo}/issues`, '-f', `title=${plan.title}`,
        '-f', `body=${plan.body}`, '-f', `labels[]=${WAVE_LABEL}`]));
      number = created.number;
      reused = false;
      const err = attach(repo, epic, created.id, runGh, { replace: false });
      if (err) throw new Error(`created wave sub-epic #${number} but could not attach it to #${epic} (${err}); run open again`);
    }
  }

  const moved = [];
  const listed = [...plan.listed];
  for (const ref of plan.move) {
    const err = attach(repo, number, movable.get(keyOf(ref)), runGh);
    if (err) {
      warn(`warning: could not move ${ref} under wave sub-epic #${number} (${err}); it keeps its parent`);
      listed.push(ref);
    } else {
      moved.push(ref);
    }
  }
  return { number, wave, moved, listed, reused };
}

const WAVE_VIEW_QUERY =
  'query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){issue(number:$n)'
  + '{state labels(first:100){nodes{name}} parent{number repository{nameWithOwner}}}}}';

/**
 * Close one wave sub-epic: return every open child to the epic, post one comment
 * with the per-issue table, and close the sub-epic only if every return
 * succeeded. A closed wave with no open child is a no-op, and a wave with only
 * stuck returns gets no comment (the CLI's exit 1 reports it), so a re-run does
 * not repeat itself.
 *
 * Refuses, before any write, an issue that isn't labelled `ship-dag-wave`, isn't
 * a sub-issue of `epic`, or an `outcomes` key that isn't an issue ref.
 *
 * @param {{repo:string, epic:number, waveEpic:number,
 *          outcomes?:Record<string,{finalState?:string, failureReason?:string, pr?:number|string}>}} input
 *   `outcomes` only fills the PR and note columns; it never decides a return.
 * @param {(argv:string[]) => string} runGh
 * @returns {{closed:boolean, returned:string[], stuck:string[], noop:boolean}}
 */
export function closeWaveEpic({ repo, epic, waveEpic, outcomes = {} }, runGh) {
  const known = new Map(Object.entries(outcomes).map(([r, o]) => [keyOf(qualifyRef(r, repo)), o || {}]));
  const [owner, name] = repo.split('/');
  const resp = JSON.parse(runGh(['api', 'graphql', '-f', `query=${WAVE_VIEW_QUERY}`,
    '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `n=${waveEpic}`]));
  const view = resp && resp.data && resp.data.repository && resp.data.repository.issue;
  if (!view) throw new WaveEpicRefusal(`#${waveEpic} in ${repo} could not be read`);
  if (!hasWaveLabel(view)) throw new WaveEpicRefusal(`#${waveEpic} in ${repo} is not labelled ${WAVE_LABEL}; refusing to touch it`);
  const parent = view.parent;
  if (!parent || parent.number !== epic || !sameRepo(subIssueRepo(parent, repo), repo)) {
    throw new WaveEpicRefusal(`#${waveEpic} in ${repo} is not a sub-issue of #${epic}; refusing to move its issues there`);
  }

  const kids = listSubIssues({ number: waveEpic, repo }, runGh);
  const open = kids.filter((k) => k.state === 'OPEN');
  if (view.state === 'CLOSED' && !open.length) return { closed: false, returned: [], stuck: [], noop: true };

  const fate = new Map(); // ref → 'returned' | 'stuck'
  for (const k of open) fate.set(refOfNode(k, repo), attach(repo, epic, k.databaseId, runGh) ? 'stuck' : 'returned');
  const returned = [...fate].filter(([, f]) => f === 'returned').map(([r]) => r);
  const stuck = [...fate].filter(([, f]) => f === 'stuck').map(([r]) => r);
  const closing = view.state === 'OPEN' && !stuck.length;

  if (returned.length || closing) {
    const label = { returned: `returned to #${epic}`, stuck: 'stuck (return failed)' };
    const rows = kids.map((k) => {
      const ref = refOfNode(k, repo);
      const o = known.get(keyOf(ref)) || {};
      return `| ${shortRef(ref, repo)} | ${label[fate.get(ref)] || 'closed'} | ${o.pr ? `#${o.pr}` : '—'} | ${o.failureReason || o.finalState || ''} |`;
    });
    const text = ['Wave closed by ship-dag.', '', '| Issue | State | PR | Note |', '|---|---|---|---|', ...rows,
      ...(stuck.length ? ['', `Left open: ${stuck.length} issue(s) could not be returned to #${epic}.`] : [])].join('\n');
    runGh(['issue', 'comment', String(waveEpic), '-R', repo, '--body', text]);
  }
  if (closing) runGh(['issue', 'close', String(waveEpic), '-R', repo, '--reason', 'completed']);
  return { closed: closing, returned, stuck, noop: false };
}
