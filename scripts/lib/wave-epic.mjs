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

import { ghNotFound } from './gh.mjs';
import { listSubIssues, hasWaveLabel, hasSubIssues, subIssueRepo, WAVE_LABEL } from './sub-issues.mjs';
import { parseRef, formatRef, refKey, sameRepo } from './ref.mjs';

const WAVE_TITLE = / — wave (\d+)$/;

/** A refusal raised before any GitHub write: the CLI exits 2, and nothing needs undoing. */
export class WaveEpicRefusal extends Error {}

/** `owner/repo#N`, `#N` or `N` → `owner/repo#N`, a bare number qualified to `repo`. */
export function qualifyRef(ref, repo) {
  const text = String(ref).trim();
  const full = parseRef(text);
  if (full) return formatRef(full.repo, full.number);
  const bare = /^#?(\d+)$/.exec(text);
  if (!bare) throw new WaveEpicRefusal(`not an issue ref: ${JSON.stringify(ref)}`);
  return formatRef(repo, Number(bare[1]));
}

// GitHub repo names are case-insensitive, and `--repo` is used as typed, so
// refs are compared by `refKey` and displayed as given.
const refOfNode = (node, repo) => formatRef(subIssueRepo(node, repo), node.number);
const shortRef = (ref, repo) => { const p = parseRef(ref); return p && sameRepo(p.repo, repo) ? `#${p.number}` : ref; };
const waveNumberOf = (title) => { const m = String(title || '').match(WAVE_TITLE); return m ? Number(m[1]) : null; };

/**
 * What a new wave sub-epic looks like, before any GitHub write. Pure.
 *
 * @param {{repo:string, epic:number, epicTitle:string, wave:number, refs:string[], movable:Set<string>}} input
 *   `refs` are qualified; `movable` holds the `refKey` of every ref that may move.
 * @returns {{title:string, move:string[], listed:string[], body:string}}
 */
export function planWaveEpic({ repo, epic, epicTitle, wave, refs, movable }) {
  const move = refs.filter((r) => movable.has(refKey(r)));
  const listed = refs.filter((r) => !movable.has(refKey(r)));
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
  const empty = openWaves.find((w) => !hasSubIssues(w));

  // Every issue this wave may move, keyed for lookup, with the REST id the move needs.
  const movable = new Map();
  const addMovable = (node) => {
    if (sameRepo(subIssueRepo(node, repo), repo)) movable.set(refKey(refOfNode(node, repo)), node.databaseId);
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
    const err = attach(repo, number, movable.get(refKey(ref)), runGh);
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
 * a sub-issue of `epic`, a `waveEpic` gh cannot find ("could not be read"), or an `outcomes` key that isn't an issue ref.
 *
 * @param {{repo:string, epic:number, waveEpic:number,
 *          outcomes?:Record<string,{finalState?:string, failureReason?:string, pr?:number|string}>}} input
 *   `outcomes` only fills the PR and note columns; it never decides a return.
 * @param {(argv:string[]) => string} runGh
 * @returns {{closed:boolean, returned:string[], stuck:string[], noop:boolean}}
 */
export function closeWaveEpic({ repo, epic, waveEpic, outcomes = {} }, runGh) {
  const known = new Map(Object.entries(outcomes).map(([r, o]) => [refKey(qualifyRef(r, repo)), o || {}]));
  const [owner, name] = repo.split('/');
  let out;
  try {
    out = runGh(['api', 'graphql', '-f', `query=${WAVE_VIEW_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `n=${waveEpic}`]);
  } catch (err) {
    // gh exits 1 on a NOT_FOUND body, so a wrong or deleted wave epic arrives as a throw; running again can't help.
    if (ghNotFound(err)) throw new WaveEpicRefusal(`#${waveEpic} in ${repo} could not be read`);
    throw err;
  }
  const resp = JSON.parse(out);
  const view = resp && resp.data && resp.data.repository && resp.data.repository.issue;
  if (!view) throw new WaveEpicRefusal(`#${waveEpic} in ${repo} could not be read`);
  if (!hasWaveLabel(view)) throw new WaveEpicRefusal(`#${waveEpic} in ${repo} is not labelled ${WAVE_LABEL}; refusing to touch it`);
  const parent = view.parent;
  if (!parent || parent.number !== epic || !sameRepo(subIssueRepo(parent, repo), repo)) {
    throw new WaveEpicRefusal(`#${waveEpic} in ${repo} is not a sub-issue of #${epic}; refusing to move its issues there`);
  }

  return settleWave({ repo, epic, waveEpic, state: view.state, kids: listSubIssues({ number: waveEpic, repo }, runGh), known }, runGh);
}

/**
 * The part of closing a wave that writes, given its state and listed children:
 * return every open child to the epic, comment, and close if every return
 * succeeded. `closeWaveEpic` and `sweepWaveEpics` both end here, so a sweep and
 * a close can't disagree about what settling a wave means. With `dryRun` it
 * writes nothing and reports what it would do, assuming every return succeeds.
 */
function settleWave({ repo, epic, waveEpic, state, kids, known = new Map(), note = 'Wave closed by ship-dag.', dryRun = false }, runGh) {
  const open = kids.filter((k) => k.state === 'OPEN');
  if (state === 'CLOSED' && !open.length) return { closed: false, returned: [], stuck: [], noop: true };

  const fate = new Map(); // ref → 'returned' | 'stuck'
  for (const k of open) {
    fate.set(refOfNode(k, repo), !dryRun && attach(repo, epic, k.databaseId, runGh) ? 'stuck' : 'returned');
  }
  const returned = [...fate].filter(([, f]) => f === 'returned').map(([r]) => r);
  const stuck = [...fate].filter(([, f]) => f === 'stuck').map(([r]) => r);
  const closing = state === 'OPEN' && !stuck.length;
  if (dryRun) return { closed: closing, returned, stuck, noop: false };

  if (returned.length || closing) {
    const label = { returned: `returned to #${epic}`, stuck: 'stuck (return failed)' };
    const rows = kids.map((k) => {
      const ref = refOfNode(k, repo);
      const o = known.get(refKey(ref)) || {};
      return `| ${shortRef(ref, repo)} | ${label[fate.get(ref)] || 'closed'} | ${o.pr ? `#${o.pr}` : '—'} | ${o.failureReason || o.finalState || ''} |`;
    });
    const text = [note, '', '| Issue | State | PR | Note |', '|---|---|---|---|', ...rows,
      ...(stuck.length ? ['', `Left open: ${stuck.length} issue(s) could not be returned to #${epic}.`] : [])].join('\n');
    runGh(['issue', 'comment', String(waveEpic), '-R', repo, '--body', text]);
  }
  if (closing) runGh(['issue', 'close', String(waveEpic), '-R', repo, '--reason', 'completed']);
  return { closed: closing, returned, stuck, noop: false };
}

const SWEEP_NOTE = {
  OPEN: 'Wave sub-epic left open (lost session or failed return); swept by ship-dag.',
  CLOSED: 'Wave sub-epic was closed with open issues under it; swept by ship-dag, which returned them to the epic.',
};

/**
 * Settle every wave sub-epic of `epic` that a lost session or a failed return
 * left behind — one still open, or one closed over an open issue — except
 * `except`, the wave this pass just opened. A closed wave with nothing open
 * under it costs its one listing and no write, so running this every wave stays
 * cheap and quiet. Each wave is settled on its own: one that fails is reported
 * in `errors` and the rest still run. With `dryRun` nothing is written and the
 * report assumes every return succeeds.
 *
 * @param {{repo:string, epic:number, except?:number, dryRun?:boolean}} input
 * @param {(argv:string[]) => string} runGh
 * @returns {{closed:string[], returned:string[], stuck:string[], errors:Array<{wave:string, message:string}>}}
 *   `closed` holds wave refs; `returned` and `stuck` hold the issues under them.
 */
export function sweepWaveEpics({ repo, epic, except, dryRun = false }, runGh) {
  const report = { closed: [], returned: [], stuck: [], errors: [] };
  const waves = listSubIssues({ number: epic, repo }, runGh)
    .filter((w) => hasWaveLabel(w) && sameRepo(subIssueRepo(w, repo), repo) && w.number !== except);
  for (const w of waves) {
    const ref = refOfNode(w, repo);
    try {
      const out = settleWave({ repo, epic, waveEpic: w.number, state: w.state, note: SWEEP_NOTE[w.state],
        kids: listSubIssues({ number: w.number, repo }, runGh), dryRun }, runGh);
      if (out.closed) report.closed.push(ref);
      report.returned.push(...out.returned);
      report.stuck.push(...out.stuck);
    } catch (err) {
      report.errors.push({ wave: ref, message: err.message });
    }
  }
  return report;
}
