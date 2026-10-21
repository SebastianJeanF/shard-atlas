import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({window:{},URL});
vm.runInContext(fs.readFileSync(new URL('../static/academic.js',import.meta.url),'utf8'),context);
const academic = context.window.AcademicAtlas;
const native = value => JSON.parse(JSON.stringify(value));
let passed = 0;
const check = (title,run) => {run();passed++;console.log(`✓ ${title}`);};
const occurrence = values => ({courseCode:'CS 4789',courseTitle:'Reinforcement Learning',term:'Fall 2026',lecture:'Lecture 2',position:2,sourceUrl:'',sourceLocation:'',context:'',...values});
const shard = values => ({id:'bellman',title:'Bellman equations',content:'A shared explanation.',subjects:['Mathematics','ML'],courses:[],notation:[],assumptions:[],...values});
const input = (key,value) => ({dataset:{academicField:key},value});
const row = values => ({querySelectorAll:()=>Object.entries(values).map(([key,value])=>input(key,value))});
function mockEditor({subjects='',courses=[],notation=[],assumptions=''} = {}) {
  return {matches:selector=>selector==='[data-academic-editor]',querySelector:selector=>selector==='[data-academic-subjects]'?{value:subjects}:selector==='[data-academic-assumptions]'?{value:assumptions}:null,querySelectorAll:selector=>selector==='[data-academic-course-row]'?courses.map(row):selector==='[data-academic-notation-row]'?notation.map(row):[]};
}
const rawCourse = values => ({courseCode:'CS 4789',courseTitle:'',term:'Fall 2026',lecture:'Notes 3',position:'3',sourceUrl:'',sourceLocation:'',context:'',...values});
const rawNotation = values => ({symbol:'γ',meaning:'Discount factor',shape:'Scalar',role:'Fixed input',scope:'This explanation',...values});

check('course keys normalize code while preserving term scope',()=>{
  assert.equal(academic.keyForCourse(occurrence({courseCode:' cs 4789 '})),academic.keyForCourse(occurrence({courseCode:'CS 4789'})));
  assert.notEqual(academic.keyForCourse(occurrence({term:'Fall 2026'})),academic.keyForCourse(occurrence({term:'Fall 2027'})));
});
check('one concept is shared across course occurrences without duplicate collection counts',()=>{
  const collections = academic.getCourseCollections([shard({courses:[occurrence({}),occurrence({lecture:'Lecture 3',position:3}),occurrence({courseCode:'MATH 2940'})]})]);
  assert.equal(collections.length,2);
  assert.equal(collections[0].shards.length,1);
  assert.equal(collections[0].occurrences.length,2);
});
check('course lectures use numeric order and preserve occurrence context',()=>{
  const data=[shard({id:'late',title:'Later',courses:[occurrence({lecture:'Lecture 10',position:10})]}),shard({id:'early',title:'Earlier',courses:[occurrence({lecture:'Lecture 2',position:2,sourceLocation:'Page 4',context:'A course-specific interpretation.'})]})];
  const html=academic.renderCourses(data,{courseKey:academic.keyForCourse(occurrence({}))});
  assert.ok(html.indexOf('data-lecture="Lecture 2"')<html.indexOf('data-lecture="Lecture 10"'));
  assert.ok(html.includes('A course-specific interpretation.'));
  assert.ok(html.includes('Page 4'));
});
check('lecture and text filters narrow occurrences without creating new concepts',()=>{
  const data=[shard({id:'one',title:'Policy evaluation',courses:[occurrence({lecture:'Lecture 2',position:2})]}),shard({id:'two',title:'Value iteration',courses:[occurrence({lecture:'Lecture 3',position:3})]})];
  const html=academic.renderCourses(data,{courseKey:academic.keyForCourse(occurrence({})),lecture:'Lecture 3',query:'value'});
  assert.ok(html.includes('data-id="two"'));
  assert.ok(!html.includes('data-id="one"'));
});
check('course and metadata HTML escape authored text and reject unsafe source links',()=>{
  const data=shard({title:'<script>alert(1)</script>',courses:[occurrence({courseTitle:'<img src=x onerror=alert(1)>',sourceUrl:'javascript:alert(1)',context:'<unsafe>'})],notation:[{symbol:'<svg/onload=alert(1)>',meaning:'<meaning>'}],assumptions:['<assumption>']});
  const html=academic.renderCourses([data],{courseKey:academic.keyForCourse(occurrence({}))})+academic.renderMetadata(data);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes('&lt;unsafe&gt;'));
  assert.ok(html.includes('&lt;svg/onload=alert(1)&gt;'));
});
check('empty courses provide useful actions without fabricating memberships',()=>{
  const html=academic.renderCourses([shard({})]);
  assert.ok(html.includes('academic-new-shard'));
  assert.ok(html.includes('One concept can belong to several lectures or courses'));
  assert.ok(!html.includes('CS 4789'));
});
check('notation keeps the local meaning, shape, role and assumptions visible',()=>{
  const html=academic.renderMetadata(shard({notation:[rawNotation({})],assumptions:['Bounded rewards']}));
  for (const value of ['Discount factor','Scalar','Fixed input','This explanation','Bounded rewards']) assert.ok(html.includes(value));
  assert.ok(html.includes('<details class="academic-symbol-entry">'));
});
check('blank editor rows are retained for drafts and dropped only during validated save',()=>{
  const editor=mockEditor({courses:[rawCourse({courseCode:'',term:'',lecture:'',position:''})],notation:[rawNotation({symbol:'',meaning:'',shape:'',role:'',scope:''})]});
  assert.equal(academic.readEditor(editor,{validate:false}).courses.length,1);
  assert.equal(academic.readEditor(editor,{validate:false}).notation.length,1);
  assert.equal(academic.readEditor(editor).courses.length,0);
  assert.equal(academic.readEditor(editor).notation.length,0);
});
check('partial rows survive drafting but fail validated save with actionable errors',()=>{
  const courses=mockEditor({courses:[rawCourse({courseCode:''})]});
  assert.equal(academic.readEditor(courses,{validate:false}).courses[0].lecture,'Notes 3');
  assert.throws(()=>academic.readEditor(courses),/course code is required/);
  assert.throws(()=>academic.readEditor(mockEditor({notation:[rawNotation({meaning:''})]})),/meaning is required/);
});
check('editor validates numeric ordering, link protocol and metadata capacity',()=>{
  assert.throws(()=>academic.readEditor(mockEditor({courses:[rawCourse({position:'-1'})]})),/lecture order/);
  assert.throws(()=>academic.readEditor(mockEditor({courses:[rawCourse({sourceUrl:'javascript:alert(1)'})]})),/http or https/);
  assert.throws(()=>academic.readEditor(mockEditor({subjects:Array.from({length:21},(_,index)=>`Subject ${index}`).join(',')})),/at most 20 subjects/);
});
check('valid editor values roundtrip without converting one course meaning into another',()=>{
  const result=native(academic.readEditor(mockEditor({subjects:' Mathematics, ML, Mathematics ',courses:[rawCourse({sourceUrl:'https://example.org/notes',sourceLocation:'§3.2'})],notation:[rawNotation({scope:'CS 4789 Notes 3'})],assumptions:'Bounded rewards\n\nFinite states'})));
  assert.deepEqual(result.subjects,['Mathematics','ML']);
  assert.equal(result.courses[0].position,3);
  assert.equal(result.courses[0].sourceLocation,'§3.2');
  assert.equal(result.notation[0].scope,'CS 4789 Notes 3');
  assert.deepEqual(result.assumptions,['Bounded rewards','Finite states']);
});
check('editor controls have explicit labels and isolated action names',()=>{
  const html=academic.renderEditor(shard({courses:[occurrence({})],notation:[rawNotation({})]}));
  for (const label of ['Course code','Lecture order','Source location','Meaning in this explanation','Type / shape','Assumptions']) assert.ok(html.includes(label));
  assert.ok(html.includes('data-academic-action="add-course"'));
  assert.ok(html.includes('aria-required="true"'));
});
console.log(`${passed} academic frontend checks passed.`);
