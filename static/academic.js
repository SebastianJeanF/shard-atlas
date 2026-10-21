/* Course context stays attached to shared concepts; symbols stay local to explanations. */
(() => {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const text = value => String(value ?? '').trim();
  const list = value => Array.isArray(value) ? value : [];
  const compare = (left, right) => String(left).localeCompare(String(right), 'en', {numeric:true});
  const keyForCourse = course => JSON.stringify([text(course?.courseCode).toLocaleUpperCase('en'), text(course?.term)]);
  const safeUrl = value => {try {const url = new URL(String(value)); return ['http:','https:'].includes(url.protocol) ? url.href : '';} catch {return '';}};
  const sourceLink = (url, label = 'Open source') => safeUrl(url) ? `<a href="${escape(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${escape(label)} ↗</a>` : '';
  const snippet = value => String(value || '').replace(/```[\s\S]*?```/g, ' [code] ').replace(/!\[[^\]]*\]\([^)]*\)/g, ' [image] ').replace(/[#*`]/g, '').replace(/\s+/g, ' ').trim().slice(0,170);
  let editorSequence = 0;
  let rowSequence = 0;

  function getCourseCollections(shards) {
    const collections = new Map();
    for (const shard of list(shards)) {
      for (const occurrence of list(shard.courses)) {
        if (!text(occurrence?.courseCode)) continue;
        const key = keyForCourse(occurrence);
        if (!collections.has(key)) collections.set(key, {key,courseCode:text(occurrence.courseCode),courseTitle:text(occurrence.courseTitle),term:text(occurrence.term),occurrences:[],shards:[]});
        const course = collections.get(key);
        if (!course.courseTitle && text(occurrence.courseTitle)) course.courseTitle = text(occurrence.courseTitle);
        course.occurrences.push({shard,occurrence});
        if (!course.shards.some(value => value.id === shard.id)) course.shards.push(shard);
      }
    }
    return [...collections.values()].sort((left,right) => compare(left.courseCode,right.courseCode) || compare(left.term,right.term));
  }

  function lectureGroups(course) {
    const groups = new Map();
    for (const entry of course.occurrences) {
      const lecture = text(entry.occurrence.lecture);
      if (!groups.has(lecture)) groups.set(lecture, {lecture,position:Number(entry.occurrence.position) || 0,entries:[]});
      const group = groups.get(lecture);
      group.position = Math.min(group.position, Number(entry.occurrence.position) || 0);
      group.entries.push(entry);
    }
    return [...groups.values()].sort((left,right) => left.position-right.position || compare(left.lecture,right.lecture)).map(group => ({...group,entries:group.entries.sort((left,right) => compare(left.shard.title,right.shard.title) || compare(left.shard.id,right.shard.id))}));
  }

  function renderCourseCard(course) {
    const lectures = lectureGroups(course).filter(group => group.lecture).length;
    return `<button type="button" class="academic-course-card" data-action="academic-open-course" data-course="${escape(course.key)}"><span class="academic-course-code">${escape(course.courseCode)}</span><h2>${escape(course.courseTitle || course.courseCode)}</h2><span class="academic-course-term">${escape(course.term || 'Term not specified')}</span><span class="academic-course-counts">${course.shards.length} ${course.shards.length===1?'shard':'shards'} · ${lectures} ${lectures===1?'lecture':'lectures'}</span><span class="academic-course-open" aria-hidden="true">Explore course ↗</span></button>`;
  }

  function renderOccurrence({shard,occurrence}, courseKey) {
    const otherCourses = new Set(list(shard.courses).filter(course => keyForCourse(course) !== courseKey).map(keyForCourse));
    return `<article class="academic-shard-card"><button type="button" class="academic-shard-open" data-action="academic-open-shard" data-id="${escape(shard.id)}"><h3>${escape(shard.title)}</h3><p>${escape(snippet(shard.content)) || 'Open this shard to read its explanation.'}</p><span class="academic-open-label">Open shared concept ↗</span></button>${occurrence.context?`<p class="academic-course-context">${escape(occurrence.context)}</p>`:''}<div class="academic-occurrence-footer">${occurrence.sourceLocation?`<span>${escape(occurrence.sourceLocation)}</span>`:''}${sourceLink(occurrence.sourceUrl)}${otherCourses.size?`<span class="academic-shared">Shared with ${otherCourses.size} other ${otherCourses.size===1?'course':'courses'}</span>`:''}</div></article>`;
  }

  function renderCourses(shards, options = {}) {
    const courses = getCourseCollections(shards), query = text(options.query).toLocaleLowerCase('en');
    const course = courses.find(value => value.key === options.courseKey);
    const search = `<label class="academic-course-search">${course?'Search this course':'Find a course or concept'}<input type="search" data-academic-course-search value="${escape(options.query || '')}" placeholder="${course?'Search titles, lecture context, and sources…':'Course, term, lecture, or concept…'}" autocomplete="off"></label>`;
    const heading = `<div class="page-heading"><div><span class="eyebrow">LEARN IN CONTEXT</span><h1>${course?escape(course.courseCode):'Your courses.'}</h1><p>${course?escape([course.courseTitle,course.term].filter(Boolean).join(' · ')):'Follow lectures in order while keeping each concept connected to your whole atlas.'}</p></div><div class="heading-actions"><button type="button" class="primary" data-action="academic-new-shard">＋ New shard</button></div></div>`;
    if (!courses.length) return heading + `<section class="academic-empty"><span aria-hidden="true">▤</span><h2>Your course collections start with a shard.</h2><p>Edit a shard and add its course, term, and lecture under Course &amp; notation. One concept can belong to several lectures or courses.</p><button type="button" class="secondary" data-action="academic-new-shard">Create a course shard</button></section>`;
    if (!course) {
      const matching = courses.filter(value => !query || [value.courseCode,value.courseTitle,value.term,...value.occurrences.flatMap(entry=>[entry.occurrence.lecture,entry.occurrence.context,entry.shard.title])].join(' ').toLocaleLowerCase('en').includes(query));
      return heading + search + `<div class="academic-course-summary"><span>${courses.length} ${courses.length===1?'course collection':'course collections'}</span><span>Shared shards · source context preserved</span></div><div class="academic-course-grid">${matching.map(renderCourseCard).join('')}</div>${matching.length?'':'<p class="academic-no-results">No courses match this search.</p>'}`;
    }
    const allGroups = lectureGroups(course);
    const groups = allGroups.filter(group => !options.lecture || group.lecture === options.lecture).map(group => ({...group,entries:group.entries.filter(({shard,occurrence}) => !query || [shard.title,shard.content,occurrence.lecture,occurrence.context,occurrence.sourceLocation].join(' ').toLocaleLowerCase('en').includes(query))})).filter(group => group.entries.length);
    return heading + `<div class="academic-course-toolbar"><button type="button" class="text-button" data-action="academic-course-all">← All courses</button><span>${course.shards.length} shared ${course.shards.length===1?'shard':'shards'}</span></div>` + search + `<nav class="academic-lecture-nav" aria-label="Lectures in ${escape(course.courseCode)}"><button type="button" class="${options.lecture?'':'active'}" data-action="academic-open-lecture" data-lecture="" aria-pressed="${!options.lecture}">All lectures</button>${allGroups.filter(group=>group.lecture).map(group=>`<button type="button" class="${options.lecture===group.lecture?'active':''}" data-action="academic-open-lecture" data-lecture="${escape(group.lecture)}" aria-pressed="${options.lecture===group.lecture}">${escape(group.lecture)}</button>`).join('')}</nav>` + groups.map(group=>`<section class="academic-lecture"><header><h2>${escape(group.lecture || 'Course foundations')}</h2><span>${new Set(group.entries.map(entry=>entry.shard.id)).size} ${group.entries.length===1?'shard':'shards'}</span></header><div class="academic-lecture-grid">${group.entries.map(entry=>renderOccurrence(entry,course.key)).join('')}</div></section>`).join('') + (groups.length?'':'<p class="academic-no-results">No shards match this lecture and search.</p>');
  }

  function renderMetadata(shard, options = {}) {
    const subjects = list(shard?.subjects), courses = list(shard?.courses), notation = list(shard?.notation), assumptions = list(shard?.assumptions);
    if (![subjects,courses,notation,assumptions].some(values=>values.length)) return '';
    const renderSymbol = typeof options.renderSymbol === 'function' ? options.renderSymbol : escape;
    return `<section class="academic-metadata" aria-label="Course context and notation">${subjects.length?`<div class="academic-subjects" aria-label="Subjects">${subjects.map(subject=>`<span>${escape(subject)}</span>`).join('')}</div>`:''}${courses.length?`<details class="academic-course-memberships"><summary>Course context <span>${courses.length}</span></summary><div>${courses.map(course=>`<article><button type="button" class="text-button" data-action="academic-open-course" data-course="${escape(keyForCourse(course))}">${escape([course.courseCode,course.term].filter(Boolean).join(' · '))} ↗</button>${course.courseTitle?`<strong>${escape(course.courseTitle)}</strong>`:''}${course.lecture?`<p>${escape(course.lecture)}</p>`:''}${course.context?`<p class="academic-course-context">${escape(course.context)}</p>`:''}<div class="academic-occurrence-footer">${course.sourceLocation?`<span>${escape(course.sourceLocation)}</span>`:''}${sourceLink(course.sourceUrl)}</div></article>`).join('')}</div></details>`:''}${notation.length?`<div class="academic-notation-inspector"><h3>Notation in this explanation</h3><p>Open a symbol to inspect its meaning and role.</p>${notation.map(entry=>`<details class="academic-symbol-entry"><summary><span class="academic-symbol">${renderSymbol(entry.symbol)}</span><span>${escape(entry.meaning)}</span></summary><dl>${entry.shape?`<div><dt>Type / shape</dt><dd>${escape(entry.shape)}</dd></div>`:''}${entry.role?`<div><dt>Role</dt><dd>${escape(entry.role)}</dd></div>`:''}<div><dt>Scope</dt><dd>${escape(entry.scope || 'This explanation')}</dd></div></dl></details>`).join('')}</div>`:''}${assumptions.length?`<details class="academic-assumptions"><summary>Assumptions <span>${assumptions.length}</span></summary><ul>${assumptions.map(value=>`<li>${escape(value)}</li>`).join('')}</ul></details>`:''}</section>`;
  }

  function field(prefix, key, label, value, options = {}) {
    const identifier = `${prefix}-${key}`, attributes = `id="${identifier}" name="${identifier}" data-academic-field="${key}"${options.required?' aria-required="true"':''}${options.placeholder?` placeholder="${escape(options.placeholder)}"`:''}`;
    return `<label class="field${options.wide?' academic-field-wide':''}" for="${identifier}">${label}${options.multiline?`<textarea ${attributes} rows="${options.rows || 2}">${escape(value || '')}</textarea>`:`<input ${attributes} type="${options.type || 'text'}" value="${escape(value ?? '')}"${options.type==='number'?' min="0" max="100000" step="any"':''}${options.maxlength?` maxlength="${options.maxlength}"`:''}>`}</label>`;
  }

  function courseRow(course = {}) {
    const prefix = `academic-course-${++rowSequence}`;
    return `<fieldset class="academic-editor-row" data-academic-course-row><legend>Course occurrence</legend><button type="button" class="text-button academic-remove-row" data-academic-action="remove-course" aria-label="Remove this course occurrence">Remove</button><div class="academic-editor-grid">${field(prefix,'courseCode','Course code',course.courseCode,{required:true,placeholder:'e.g. CS 4789',maxlength:80})}${field(prefix,'courseTitle','Course title',course.courseTitle,{placeholder:'e.g. Introduction to Reinforcement Learning',maxlength:240})}${field(prefix,'term','Term',course.term,{placeholder:'e.g. Fall 2026',maxlength:80})}${field(prefix,'lecture','Lecture / reading',course.lecture,{placeholder:'e.g. Notes 3: Value iteration',maxlength:240})}${field(prefix,'position','Lecture order',course.position ?? 0,{type:'number'})}${field(prefix,'sourceLocation','Source location',course.sourceLocation,{placeholder:'e.g. §3.2, pages 4–5',maxlength:240})}${field(prefix,'sourceUrl','Course source link',course.sourceUrl,{placeholder:'https://…',wide:true,maxlength:2048})}${field(prefix,'context','How this course uses the concept',course.context,{multiline:true,wide:true})}</div></fieldset>`;
  }

  function notationRow(entry = {}) {
    const prefix = `academic-notation-${++rowSequence}`;
    return `<fieldset class="academic-editor-row" data-academic-notation-row><legend>Symbol definition</legend><button type="button" class="text-button academic-remove-row" data-academic-action="remove-notation" aria-label="Remove this symbol definition">Remove</button><div class="academic-editor-grid">${field(prefix,'symbol','Symbol',entry.symbol,{required:true,placeholder:'e.g. γ or \\gamma',maxlength:120})}${field(prefix,'meaning','Meaning in this explanation',entry.meaning,{required:true,placeholder:'e.g. Discount factor',maxlength:2000})}${field(prefix,'shape','Type / shape',entry.shape,{placeholder:'e.g. Scalar, vector in ℝⁿ, or matrix',maxlength:120})}${field(prefix,'role','Role',entry.role,{placeholder:'e.g. Fixed input; current estimate; optimal output',maxlength:240})}${field(prefix,'scope','Scope',entry.scope,{placeholder:'e.g. Notes 3, discounted infinite-horizon section',wide:true,maxlength:240})}</div></fieldset>`;
  }

  function renderEditor(shard = {}) {
    const prefix = `academic-editor-${++editorSequence}`;
    const courses = list(shard.courses), notation = list(shard.notation), subjects = list(shard.subjects), assumptions = list(shard.assumptions);
    return `<section class="academic-editor" data-academic-editor><details class="academic-editor-details"${courses.length||notation.length||subjects.length||assumptions.length?' open':''}><summary>Course &amp; notation <span>Optional context for any subject</span></summary><div class="academic-editor-body"><label class="field" for="${prefix}-subjects">Subjects<input id="${prefix}-subjects" name="${prefix}-subjects" data-academic-subjects value="${escape(subjects.join(', '))}" placeholder="e.g. Mathematics, ML, Computer Science"><span class="field-hint">Separate subjects with commas. One shard can appear in several subject views.</span></label><div class="academic-editor-section"><div class="academic-editor-section-heading"><div><h3>Course occurrences</h3><p>Keep the shared concept once. Add the lectures or courses where you encountered it.</p></div><button type="button" class="secondary" data-academic-action="add-course">＋ Course</button></div><div data-academic-course-rows>${courses.map(courseRow).join('')}</div><p class="academic-editor-empty"${courses.length?' hidden':''} data-academic-courses-empty>No course membership added.</p></div><div class="academic-editor-section"><div class="academic-editor-section-heading"><div><h3>Notation</h3><p>Define each symbol here; another explanation may use it differently.</p></div><button type="button" class="secondary" data-academic-action="add-notation">＋ Symbol</button></div><div data-academic-notation-rows>${notation.map(notationRow).join('')}</div><p class="academic-editor-empty"${notation.length?' hidden':''} data-academic-notation-empty>No symbol definitions added.</p></div><label class="field" for="${prefix}-assumptions">Assumptions<textarea id="${prefix}-assumptions" name="${prefix}-assumptions" data-academic-assumptions rows="3" placeholder="One assumption per line">${escape(assumptions.join('\n'))}</textarea><span class="field-hint">State the conditions needed for the result or explanation.</span></label></div></details></section>`;
  }

  function editorRoot(container) {
    return container?.matches?.('[data-academic-editor]') ? container : container?.querySelector?.('[data-academic-editor]');
  }

  function readEditor(container, options = {}) {
    const root = editorRoot(container), validate = options.validate !== false;
    if (!root) return {subjects:[],courses:[],notation:[],assumptions:[]};
    const readRows = selector => [...root.querySelectorAll(selector)].map(row => Object.fromEntries([...row.querySelectorAll('[data-academic-field]')].map(input=>[input.dataset.academicField,text(input.value)])));
    const result = {subjects:[...new Set((root.querySelector('[data-academic-subjects]')?.value || '').split(',').map(text).filter(Boolean))],courses:readRows('[data-academic-course-row]').map(row=>({...row,position:row.position===''?0:Number(row.position)})),notation:readRows('[data-academic-notation-row]'),assumptions:(root.querySelector('[data-academic-assumptions]')?.value || '').split('\n').map(text).filter(Boolean)};
    if (!validate) return result;
    const bounded = (value, name, limit, required = false) => {if (required && !value) throw new Error(`${name} is required.`); if (value.length > limit) throw new Error(`${name} must be at most ${limit.toLocaleString('en')} characters.`);};
    if (result.subjects.length > 20) throw new Error('Use at most 20 subjects per shard.');
    for (const subject of result.subjects) bounded(subject,'Each subject',80,true);
    result.courses = result.courses.filter(row=>Object.entries(row).some(([key,value])=>key==='position'?value!==0:!!value));
    if (result.courses.length > 100) throw new Error('Use at most 100 course occurrences per shard.');
    result.courses.forEach((row,index)=>{
      const label = `Course occurrence ${index+1}`;
      bounded(row.courseCode,`${label}: course code`,80,true);
      for (const [key,limit] of Object.entries({courseTitle:240,term:80,lecture:240,sourceUrl:2048,sourceLocation:240,context:5000})) bounded(row[key],`${label}: ${key}`,limit);
      if (!Number.isFinite(row.position) || row.position < 0 || row.position > 100000) throw new Error(`${label}: lecture order must be a number from 0 to 100,000.`);
      if (row.sourceUrl && !safeUrl(row.sourceUrl)) throw new Error(`${label}: use an http or https source link.`);
    });
    result.notation = result.notation.filter(row=>Object.values(row).some(Boolean));
    if (result.notation.length > 100) throw new Error('Use at most 100 symbol definitions per shard.');
    result.notation.forEach((row,index)=>{const label = `Symbol definition ${index+1}`;bounded(row.symbol,`${label}: symbol`,120,true);bounded(row.meaning,`${label}: meaning`,2000,true);for (const [key,limit] of Object.entries({shape:120,role:240,scope:240})) bounded(row[key],`${label}: ${key}`,limit);});
    if (result.assumptions.length > 100) throw new Error('Use at most 100 assumptions per shard.');
    result.assumptions.forEach(value=>bounded(value,'Each assumption',2000,true));
    return result;
  }

  function bindEditor(container, onChange = () => {}) {
    const root = editorRoot(container);
    if (!root || root.dataset.academicBound) return;
    root.dataset.academicBound = 'true';
    const changed = () => onChange(readEditor(root,{validate:false}));
    root.addEventListener('input',changed);
    root.addEventListener('change',changed);
    root.addEventListener('click',event=>{
      const button = event.target.closest('[data-academic-action]');
      if (!button || !root.contains(button)) return;
      event.preventDefault();event.stopPropagation();
      const action = button.dataset.academicAction;
      let added;
      if (action === 'add-course') {const rows=root.querySelector('[data-academic-course-rows]');rows.insertAdjacentHTML('beforeend',courseRow());added=rows.lastElementChild;}
      else if (action === 'add-notation') {const rows=root.querySelector('[data-academic-notation-rows]');rows.insertAdjacentHTML('beforeend',notationRow());added=rows.lastElementChild;}
      else if (action === 'remove-course') button.closest('[data-academic-course-row]')?.remove();
      else if (action === 'remove-notation') button.closest('[data-academic-notation-row]')?.remove();
      root.querySelector('[data-academic-courses-empty]').hidden = !!root.querySelector('[data-academic-course-row]');
      root.querySelector('[data-academic-notation-empty]').hidden = !!root.querySelector('[data-academic-notation-row]');
      changed();
      if (added) added.querySelector('input')?.focus();
      else root.querySelector(`[data-academic-action="${action==='remove-course'?'add-course':'add-notation'}"]`)?.focus();
    });
  }

  window.AcademicAtlas = Object.freeze({keyForCourse,getCourseCollections,renderCourses,renderMetadata,renderEditor,readEditor,bindEditor});
})();
