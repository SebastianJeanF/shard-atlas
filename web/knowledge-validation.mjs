import {recordId, validateCodeSolution} from './model.mjs';

const own = (item, key) => Object.prototype.hasOwnProperty.call(item, key);
const value = (item, key, fallback) => own(item, key) ? item[key] : fallback;
const fail = message => {throw Object.assign(new Error(message), {status: 400});};
function fields(item, allowed, name) {
  if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !allowed.includes(key))) fail(`${name} must contain only supported fields.`);
}
function text(item, key, maximum, required = false) {
  const supplied = value(item, key, '');
  if (typeof supplied !== 'string' || [...supplied].length > maximum || supplied.includes('\0') || required && !supplied.trim()) fail(`${key} must be ${required ? 'nonempty ' : ''}text within its length limit.`);
  return supplied;
}
function list(supplied, name, maximum, minimum = 0) {
  if (!Array.isArray(supplied) || supplied.length < minimum || supplied.length > maximum) fail(`${name} must contain between ${minimum} and ${maximum} entries.`);
  return supplied;
}
function strings(supplied, name, maximum, length) {
  for (const entry of list(supplied, name, maximum)) text({[name]: entry}, name, length, true);
}
function number(supplied, name, minimum, maximum, integer = false) {
  if (typeof supplied !== 'number' || !Number.isFinite(supplied) || supplied < minimum || supplied > maximum || integer && !Number.isInteger(supplied)) fail(`${name} must be ${integer ? 'an integer' : 'a finite number'} between ${minimum} and ${maximum}.`);
  return supplied;
}
function enumeration(item, key, fallback, allowed) {
  const supplied = value(item, key, fallback);
  if (!allowed.includes(supplied)) fail(`Unsupported ${key}.`);
  return supplied;
}
function source(item) {
  const url = text(item, 'sourceUrl', 2048); text(item, 'sourceLocation', 240);
  if (url) {
    let parsed;
    try {parsed = new URL(url);} catch {fail('sourceUrl must be an http or https URL.');}
    if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || /[\s\\]/.test(url)) fail('sourceUrl must be an http or https URL without embedded credentials.');
  }
}
function date(item, key) {
  const supplied = text(item, key, 10);
  if (!supplied) return;
  if (!/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(supplied)) fail(`${key} must use YYYY, YYYY-MM, or YYYY-MM-DD.`);
  const [year, month = 1, day = 1] = supplied.split('-').map(Number), leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) fail(`${key} must be a valid date.`);
}

function experimentConfig(config, type) {
  if (type === 'gradient-descent') {
    fields(config, ['a', 'b', 'c', 'startX', 'startY', 'learningRate', 'maxIterations', 'tolerance'], 'Gradient configuration');
    for (const [key, min, max] of [['a', .001, 1000], ['b', -1000, 1000], ['c', .001, 1000], ['startX', -100, 100], ['startY', -100, 100], ['learningRate', Number.MIN_VALUE, 10]]) number(config[key], key, min, max);
    if (config.a * config.c - config.b ** 2 <= 1e-9) fail('The gradient experiment quadratic must be positive definite.');
  } else {
    fields(config, ['states', 'actions', 'transitions', 'discount', 'maxIterations', 'tolerance'], 'Value iteration configuration');
    const states = new Map(), actions = new Set(), pairs = new Set(), available = new Set();
    for (const state of list(config.states, 'states', 12, 1)) {
      fields(state, ['id', 'label', 'terminal', 'initialValue'], 'State'); recordId(state.id); text(state, 'label', 120, true);
      if (typeof state.terminal !== 'boolean' || state.terminal && state.initialValue !== 0) fail('A terminal state must have a boolean terminal flag and initial value zero.');
      number(state.initialValue, 'initialValue', -10_000, 10_000);
      if (states.has(state.id)) fail('Experiment state IDs must be unique.');
      states.set(state.id, state);
    }
    for (const action of list(config.actions, 'actions', 4, 1)) {
      fields(action, ['id', 'label'], 'Action'); recordId(action.id); text(action, 'label', 120, true);
      if (actions.has(action.id)) fail('Experiment action IDs must be unique.');
      actions.add(action.id);
    }
    for (const row of list(config.transitions, 'transitions', 48)) {
      fields(row, ['stateId', 'actionId', 'outcomes'], 'Transition'); recordId(row.stateId); recordId(row.actionId);
      const key = JSON.stringify([row.stateId, row.actionId]);
      if (!states.has(row.stateId) || !actions.has(row.actionId) || states.get(row.stateId).terminal || pairs.has(key)) fail('Experiment transitions must use declared nonterminal states, declared actions, and unique state/action pairs.');
      pairs.add(key); available.add(row.stateId);
      let sum = 0;
      for (const outcome of list(row.outcomes, 'outcomes', 12, 1)) {
        fields(outcome, ['nextStateId', 'probability', 'reward'], 'Outcome'); recordId(outcome.nextStateId);
        if (!states.has(outcome.nextStateId)) fail('An experiment outcome refers to an undeclared state.');
        sum += number(outcome.probability, 'probability', 0, 1); number(outcome.reward, 'reward', -10_000, 10_000);
      }
      if (Math.abs(sum - 1) > 1e-9) fail('Experiment outcome probabilities must sum to one within 1e-9.');
    }
    if ([...states.values()].some(state => !state.terminal && !available.has(state.id))) fail('Every nonterminal experiment state needs an available action.');
    number(config.discount, 'discount', 0, .999);
  }
  number(config.maxIterations, 'maxIterations', 1, 500, true); number(config.tolerance, 'tolerance', 1e-12, 1);
}

/** Validate current Mac metadata while preserving the supplied JSON exactly. */
export function validateRichKnowledge(shard) {
  validateCodeSolution(value(shard, 'codeSolution', {}));
  for (const [key, maximum, length] of [['subjects', 20, 80], ['assumptions', 100, 2000]]) strings(value(shard, key, []), key, maximum, length);
  for (const course of list(value(shard, 'courses', []), 'courses', 100)) {
    fields(course, ['courseCode', 'courseTitle', 'term', 'lecture', 'position', 'sourceUrl', 'sourceLocation', 'context'], 'Course occurrence');
    text(course, 'courseCode', 80, true); text(course, 'courseTitle', 240); text(course, 'term', 80); text(course, 'lecture', 240); text(course, 'context', 5000); source(course);
    number(value(course, 'position', 0), 'course position', 0, 100_000);
  }
  for (const entry of list(value(shard, 'notation', []), 'notation', 100)) {
    fields(entry, ['symbol', 'meaning', 'shape', 'role', 'scope'], 'Notation'); text(entry, 'symbol', 120, true); text(entry, 'meaning', 2000, true);
    text(entry, 'shape', 120); text(entry, 'role', 240); text(entry, 'scope', 240);
  }
  for (const entry of list(value(shard, 'perspectives', []), 'perspectives', 20)) {
    fields(entry, ['title', 'viewpoint', 'content', 'assumptions', 'sourceUrl', 'sourceLocation'], 'Perspective'); text(entry, 'title', 240, true); text(entry, 'viewpoint', 240); text(entry, 'content', 30_000, true); strings(value(entry, 'assumptions', []), 'perspective assumptions', 20, 2000); source(entry);
  }
  for (const entry of list(value(shard, 'walkthroughs', []), 'walkthroughs', 20)) {
    fields(entry, ['title', 'kind', 'goal', 'steps', 'conclusion', 'sourceUrl', 'sourceLocation'], 'Walkthrough'); text(entry, 'title', 240, true); text(entry, 'goal', 5000); text(entry, 'conclusion', 5000); enumeration(entry, 'kind', 'derivation', ['derivation', 'trace']); source(entry);
    for (const step of list(value(entry, 'steps', []), 'walkthrough steps', 100, 1)) {
      fields(step, ['title', 'expression', 'explanation', 'justification'], 'Walkthrough step'); text(step, 'title', 240); text(step, 'justification', 5000);
      if (!text(step, 'expression', 5000).trim() && !text(step, 'explanation', 10_000).trim()) fail('A walkthrough step needs an expression or explanation.');
      text(step, 'explanation', 10_000);
    }
  }
  for (const entry of list(value(shard, 'comparisons', []), 'comparisons', 20)) {
    fields(entry, ['title', 'question', 'alternatives', 'conclusion', 'sourceUrl', 'sourceLocation'], 'Comparison'); text(entry, 'title', 240, true); text(entry, 'question', 5000); text(entry, 'conclusion', 5000); source(entry);
    for (const alternative of list(value(entry, 'alternatives', []), 'comparison alternatives', 10, 2)) {
      fields(alternative, ['name', 'shardId', 'summary', 'assumptions', 'strengths', 'limitations', 'cost'], 'Comparison alternative'); text(alternative, 'name', 240, true); text(alternative, 'summary', 5000); text(alternative, 'cost', 2000);
      const id = text(alternative, 'shardId', 120);
      if (id && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(id)) fail('Comparison shardId must be an optional stable identifier.');
      for (const key of ['assumptions', 'strengths', 'limitations']) strings(value(alternative, key, []), key, 30, 2000);
    }
  }
  for (const entry of list(value(shard, 'learningLog', []), 'learningLog', 100)) {
    fields(entry, ['kind', 'prompt', 'status', 'resolution', 'history', 'sourceUrl', 'sourceLocation'], 'Learning log entry'); text(entry, 'prompt', 5000, true); enumeration(entry, 'kind', 'question', ['question', 'misconception']); source(entry);
    const status = enumeration(entry, 'status', 'open', ['open', 'resolved']); text(entry, 'resolution', 10_000, status === 'resolved');
    for (const history of list(value(entry, 'history', []), 'learning history', 100)) {fields(history, ['date', 'note'], 'Learning history entry'); date(history, 'date'); text(history, 'note', 5000, true);}
  }
  const verification = value(shard, 'verification', {});
  fields(verification, ['status', 'note', 'sourceUrl', 'sourceLocation', 'checkedAt'], 'Verification');
  const status = enumeration(verification, 'status', 'unverified', ['unverified', 'source-checked', 'needs-correction']); source(verification); text(verification, 'note', 5000); date(verification, 'checkedAt');
  if (status === 'source-checked' && (!value(verification, 'note', '').trim() || !(value(verification, 'sourceUrl', '') || value(verification, 'sourceLocation', '').trim()))) fail('Source-checked verification needs a note and a source URL or location.');
  const ids = new Set();
  for (const experiment of list(value(shard, 'experiments', []), 'experiments', 10)) {
    fields(experiment, ['id', 'type', 'title', 'description', 'sourceUrl', 'sourceLocation', 'algorithmVersion', 'config', 'comparisonConfig'], 'Experiment');
    recordId(experiment.id); text(experiment, 'title', 240, true); text(experiment, 'description', 5000); source(experiment);
    if (ids.has(experiment.id)) fail('Experiment IDs must be unique within a shard.');
    ids.add(experiment.id);
    const type = enumeration(experiment, 'type', '', ['gradient-descent', 'value-iteration']);
    if (experiment.algorithmVersion !== 1) fail('This app supports experiment algorithmVersion 1 only.');
    experimentConfig(experiment.config, type);
    if (own(experiment, 'comparisonConfig') && experiment.comparisonConfig !== null) experimentConfig(experiment.comparisonConfig, type);
  }
}
