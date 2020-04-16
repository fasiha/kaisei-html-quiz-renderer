import {argmin, flatmap, hasKanji, kata2hira} from 'curtiz-utils';
import * as ebisu from 'ebisu-js';
import PouchDB from 'pouchdb';
import {createContext, createElement, Dispatch, Fragment, useContext, useEffect, useReducer, useState} from 'react';
import ReactDOM from 'react-dom';
import {connect, Provider} from 'react-redux';
import {AnyAction, createStore, Store} from "redux";

PouchDB.plugin(require('pouchdb-upsert'));
const ce = createElement;

interface Ruby {
  ruby: string;
  rt?: string;
}
type Furigana = string|Ruby;

enum FactType {
  Vocab = 'vocab',
  Conjugated = 'conjugated',
  Particle = 'particle',
  Sentence = 'sentence',
}

interface BaseFact {
  factType: FactType;
}
interface VocabFact extends BaseFact {
  kanjiKana: string[];
  definition: string;
  factType: FactType.Vocab;
}

interface ConjugatedFact extends BaseFact {
  expected: Furigana[];
  hints: Furigana[];
  factType: FactType.Conjugated;
}

interface ParticleFact extends BaseFact {
  left: string;
  cloze: string;
  right: string;
  factType: FactType.Particle;
}

interface SentenceFact extends BaseFact {
  furigana: Furigana[];
  subfacts: (VocabFact|ParticleFact|ConjugatedFact)[];
  translation: {[lang: string]: string};
  factType: FactType.Sentence;
}

type Fact = SentenceFact|ParticleFact|ConjugatedFact|VocabFact;

function furiganaToRuby(v: Furigana[]): string {
  return v.map(o => typeof o === 'string' ? o : o.ruby).join('').trim();
}
function furiganaToRt(v: Furigana[]): string { return v.map(o => typeof o === 'string' ? o : o.rt).join('').trim(); }
function furiganaToHiragana(v: Furigana[]): string { return kata2hira(furiganaToRt(v)); }

function rubyNodeToFurigana(node: ChildNode): Furigana {
  if (node.nodeName === 'RUBY') {
    let rt = '';
    let ruby = '';
    for (const sub of node.childNodes) {
      if (sub.nodeName === '#text') {
        ruby += sub.textContent;  // textContent is technically nullable
      } else if (sub.nodeName === 'RT') {
        rt += sub.textContent;
      }
    }
    return rt ? {ruby, rt} : ruby;
    // if this was just `<ruby>bla</ruby>` with no `rt` tag, treat this as plain
    // text. We shouldn't force everyone upstream to assume `Ruby` objects might
    // be missing `rt`.
  }
  throw new Error('Not a RUBY node');
}

function nodesToFurigana(nodes: ChildNode[]|NodeListOf<ChildNode>): Furigana[] {
  const ret: Furigana[] = [];
  for (const node of nodes) {
    if (node.nodeName === '#text') {
      ret.push(node.textContent || 'TypeScript pacification');
    } else if (node.nodeName === 'RUBY') {
      ret.push(rubyNodeToFurigana(node));
    }
  }
  return ret;
}

// 遣る・行る「やる」：① to do/to undertake/to perform/to play (a game)/to study
function textToVocab(s: string): VocabFact {
  const split = s.split('：');
  if (split.length !== 2) { throw new Error('unable to split vocab: ' + s); }
  const kanjiKana = split[0].replace('」', '').replace('「', '・').split('・').filter(s => !!s);  // leading ・
  const definition = split[1];
  return {kanjiKana, definition, factType: FactType.Vocab};
}

function textToConjugated(elt: Element): ConjugatedFact {
  const expected: Furigana[] = [];
  const hints: Furigana[] = [];

  const BREAK = '：';
  let splitFound = false;
  const contents = nodesToFurigana(elt.childNodes);
  for (const text of contents) {
    if (typeof text === 'string') {
      if (splitFound) {
        hints.push(text);
      } else if (text.includes(BREAK)) {
        // split just now found
        splitFound = true;
        const [pre, post] = text.split(BREAK);
        if (pre) { expected.push(pre); }
        if (post) { hints.push(post); }
      } else {
        // split not found
        expected.push(text);
      }
    } else {
      // text is furigana
      (splitFound ? hints : expected).push(text);
    }
  }
  return {expected, hints, factType: FactType.Conjugated};
}

function textToParticle(s: string): ParticleFact {
  const split = s.split('/');
  if (split.length === 1) {
    return {left: '', cloze: split[0], right: '', factType: FactType.Particle};
  } else if (split.length === 3) {
    return {left: split[0], cloze: split[1], right: split[2], factType: FactType.Particle};
  }
  throw new Error('unable to split: ' + s);
}

function elementToFact(elt: Element) {
  if (elt.classList.contains('vocab')) {
    return textToVocab(elt.textContent || '')
  } else if (elt.classList.contains('conjugated')) {
    return textToConjugated(elt);
  } else if (elt.classList.contains('particle')) {
    return textToParticle(elt.textContent || '');
  }
  throw new Error('unknown quizzable ' + elt);
}

function FuriganaComponent(props: {furiganas: Furigana[]}) {
  return ce(Fragment, null,
            ...props.furiganas.map(o => typeof o === 'string' ? o : ce('ruby', null, o.ruby, ce('rt', null, o.rt))))
}

function VocabComponent(props: {fact: Keyed<VocabFact>}) {
  const [learned, setLearned] = useState(undefined as undefined | Record<string, boolean>);
  const dbKeys = props.fact.keys;

  useEffect(() => {
    if (!learned) {
      async function init(dbKeys: string[]) {
        const learned: Record<string, boolean> = {};
        for (const key of dbKeys) {
          try {
            await db.get(key);
            learned[key] = true;
          } catch { learned[key] = false; }
        }
        setLearned(learned);
      }
      init(dbKeys);
    }

    const changes = db.changes({since: 'now', live: true, doc_ids: dbKeys}).on('change', change => {
      if (!learned) { return; }  // if setLearned hasn't yet updated the state, just bail
      setLearned({...learned, [change.id]: !change.deleted});
    });
    return () => changes.cancel();  // to cancel the listener when component unmounts.
  });

  if (typeof learned === 'undefined') { return ce(Fragment, null, ''); }
  const buttons = dbKeys.map(key => {
    const thisLearned = learned[key] ? 'unlearn' : 'learn!';
    const display = key.endsWith('meaning') ? 'Meaning' : 'Reading';
    return ce('button', {onClick: e => learnUnlearn(key, !(learned[key]))}, `${display} ${thisLearned}`);
  });

  return ce(Fragment, null, props.fact.kanjiKana.join('・'), '：', props.fact.definition, ...buttons);
}

function ParticleComponent(props: {fact: Keyed<ParticleFact>}) {
  const dbKey = props.fact.keys[0];
  const [learned, setLearned] = useState(undefined as undefined | boolean);

  useEffect(() => {
    if (typeof learned === 'undefined') {
      async function init(dbKey: string) {
        try {
          await db.get(dbKey);
          setLearned(true);
        } catch { setLearned(false); }
      }
      init(dbKey);
      return;
    } else {
      const changes = db.changes({since: 'now', live: true, doc_ids: [dbKey]}).on('change', change => {
        if (typeof learned === 'undefined') { return; }  // if setLearned hasn't yet updated the state, just bail
        setLearned(!change.deleted);
        // TODO this might not be necessary, i.e., if just a key changed
      });
      return () => changes.cancel();  // to cancel the listener when component unmounts.
    }
  })

  const {left, right, cloze} = props.fact;
  if (typeof learned === 'undefined') {
    return ce(Fragment, null, `${left ? '…' + left : ''}${cloze}${right ? right + '…' : ''}`)
  }
  const buttonText = learned ? 'Unlearn' : 'Learn!';
  const button = ce('button', {
    onClick: e => {
      if (typeof learned === 'undefined') { return; };
      learnUnlearn(dbKey, !learned);
    },
  },
                    buttonText);
  return ce(Fragment, null, `${left ? '…' + left : ''}${cloze}${right ? right + '…' : ''}`, button);
}

function ConjugatedComponent(props: {fact: Keyed<ConjugatedFact>}) {
  const dbKey = props.fact.keys[0];
  const [learned, setLearned] = useState(undefined as undefined | boolean);
  useEffect(() => {
    // TODO: DRY: above with particles
    if (typeof learned === 'undefined') {
      async function init(dbKey: string) {
        try {
          await db.get(dbKey);
          setLearned(true);
        } catch { setLearned(false); }
      }
      init(dbKey);
      return () => {};
    }
    const changes = db.changes({since: 'now', live: true, doc_ids: [dbKey]}).on('change', change => {
      if (typeof learned === 'undefined') { return; }
      setLearned(!change.deleted);
    });
    return () => changes.cancel();
  });
  if (typeof learned === 'undefined') {
    return ce(Fragment, null, props.fact.expected, '：', ce(FuriganaComponent, {furiganas: props.fact.hints}));
  }
  const button = ce('button', {
    onClick: e => {
      if (typeof learned === 'undefined') { return; };
      learnUnlearn(dbKey, !learned);
    },
  },
                    learned ? 'Unlearn' : 'Learn!');
  return ce(Fragment, null, props.fact.expected, '：', ce(FuriganaComponent, {furiganas: props.fact.hints}), button);
}

function Sentence(props: {fact: Keyed<SentenceFact>}) {
  const [learned, setLearned] = useState(undefined as undefined | Record<string, boolean>);
  const dbKeys = props.fact.keys;

  useEffect(() => {
    if (!learned) {
      async function init(dbKeys: string[]) {
        const learned: Record<string, boolean> = {};
        for (const key of dbKeys) {
          try {
            await db.get(key);
            learned[key] = true;
          } catch { learned[key] = false; }
        }
        setLearned(learned);
      }
      init(dbKeys);
    }

    const changes = db.changes({since: 'now', live: true, doc_ids: dbKeys}).on('change', change => {
      if (!learned) { return; }  // if setLearned hasn't yet updated the state, just bail
      setLearned({...learned, [change.id]: !change.deleted});
      // TODO this might not be necessary, i.e., if just a key changed
    });
    return () => changes.cancel();  // to cancel the listener when component unmounts.
    // `return changes.cancel.bind(changes);` should work too but triggers "MaxListenersExceededWarning"?
    // Can't just `return changes.cancel` either because `this` error.
  });

  if (typeof learned === 'undefined') { return ce(Fragment, null, ''); }
  const buttons = dbKeys.map(key => {
    const thisLearned = learned[key] ? 'unlearn' : 'learn!';
    const display = key.endsWith('meaning') ? 'Meaning' : 'Reading';
    return ce('button', {onClick: e => learnUnlearn(key, !(learned[key]))}, `${display} ${thisLearned}`);
  });

  return ce(
      Fragment,
      null,
      ce('summary', null, ce(FuriganaComponent, {furiganas: props.fact.furigana})),
      ...buttons,
      ce(
          'ul',
          null,
          ...props.fact.subfacts.map(fact =>
                                         ce('li', null,
                                            fact.factType === FactType.Vocab ? ce(VocabComponent, {fact})
                                                                             : fact.factType === FactType.Particle
                                                                                   ? ce(ParticleComponent, {fact})
                                                                                   : ce(ConjugatedComponent, {fact}))),
          ),
  );
}

type EbisuModel = ReturnType<typeof ebisu.defaultModel>;
interface Memory {
  ebisu: EbisuModel;
  lastSeen: string;
  version: '1';
}
function learnUnlearn(key: string, learn: boolean, date?: Date) {
  return db.upsert(key, old => {
    if (!learn) { return {...old, _deleted: true}; }
    const halflife = 0.5;  // hours
    const ab = 3;          // unitless
    // the initial prior on recall probability will be Beta(ab, ab) in `halflife` time units. Instead of tweaking the
    // halflife when you first learn a fact, let's let users tweak it after a review.
    const model:
        Memory = {ebisu: ebisu.defaultModel(halflife, ab), lastSeen: (date || new Date()).toISOString(), version: '1'};
    return {...old, ...model};
  });
}

export function setup() {
  const details = document.querySelectorAll('details.quizzable');
  const allKeys: string[] = [];
  for (const detail of details) {
    const sentence = detail.querySelector('.quizzable.sentence');
    if (!sentence) {
      continue;
      // TODO: vocab-only
      const vocabNode = detail.querySelector('.quizzable.vocab');
      if (!vocabNode) { continue; }
      // const fact = elementToFact(vocabNode);
    }
    const furigana = nodesToFurigana(sentence.childNodes);
    const subfacts = Array.from(detail.querySelectorAll('.quizzable:not(.sentence)'), elementToFact);
    const translation: {[s: string]: string} = {};
    for (const elt of detail.querySelectorAll('.translation')) {
      const lang = Array.from(elt.classList).find(s => s !== 'translation') || 'pacification';
      translation[lang] = elt.textContent || 'pacification 2';
    }

    const fact: Keyed<SentenceFact> = addKeys({furigana, subfacts, translation, factType: FactType.Sentence});

    const action: AddFactsAction = {type: ActionType.addFacts, facts: [fact, ...fact.subfacts]};
    pageStore.dispatch(action)

    ReactDOM.render(ce(Sentence, {fact}), detail);

    allKeys.push(...fact.keys.concat(flatmap(fact.subfacts, o => o.keys)));
  }

  async function init(dbKeys: string[]) {
    const memories: Record<string, Partial<Memory>> = {};
    for (const key of dbKeys) {
      try {
        const model = await db.get(key) as Memory;
        memories[key] = model;
      } catch { memories[key] = {}; }
    }
    const action: UpdatingMemoryAction = {type: ActionType.updatingMemories, memories};
    pageStore.dispatch(action);
  }
  init(allKeys);

  // TODO is it more efficient to use `doc_ids` or just filter?
  db.changes({since: 'now', live: true, doc_ids: allKeys, include_docs: true}).on('change', change => {
    const memories = {[change.id]: change.deleted ? {} : change.doc as unknown as Memory};
    const action: UpdatingMemoryAction = {type: ActionType.updatingMemories, memories};
    pageStore.dispatch(action);
  });
}

/** Adds `keys` field to any fact */
type Keyed1<T extends Fact> = T&{keys: string[]};
/**
Adds `keys` field to any fact AND to any subfield that happens to be an array of other facts

A simplified way of doing the following would be:
`type KeyedSentenceFact = Keyed1<SentenceFact>&{subfacts: Keyed1<SentenceFact['subfacts'][number]>[]};`
*/
type Keyed<T extends Fact> = {
  [K in keyof T]: T[K] extends Array<Fact>? Keyed1<T[K][0]>[] : T[K]
}&{keys: string[]};

function addKeys(sentence: SentenceFact): Keyed<SentenceFact> {
  const text = furiganaToRuby(sentence.furigana);
  if (text.includes('/')) { throw new Error('unhandled: text containing separator'); }
  const keys = [`model/${text}/meaning`];
  if (hasKanji(text)) { keys.push(`model/${text}/reading`); }

  const orig = sentence.subfacts;
  const subfacts: Keyed1<(typeof orig)[number]>[] = orig.map(o => {
    if (o.factType === FactType.Conjugated) {
      return { ...o, keys: [`model/${text}/conjugated/${furiganaToRuby(o.expected)}`] }
    } else if (o.factType === FactType.Particle) {
      const particleKey = [o.left, o.cloze, o.right].join('_');
      return { ...o, keys: [`model/${text}/particle/${particleKey}`] }
    } else if (o.factType === FactType.Vocab) {
      const k = o.kanjiKana.join(',');
      const keys = [`model/${k}/meaning`];
      if (hasKanji(k)) { keys.push(`model/${k}/reading`); }
      return {...o, keys};
    }
    assertNever(o);
  });
  return {...sentence, subfacts, keys};
}
function assertNever(x: never, note = 'Unexpected object: '): never { throw new Error(note + x); }

// Redux step 1: actions
enum ActionType {
  addFacts = 'addFacts',
  updatingMemories = 'updatingMemories',
}
interface AddFactsAction {
  type: ActionType.addFacts;
  facts: Keyed<Fact>[];
}
interface UpdatingMemoryAction {
  type: ActionType.updatingMemories;
  memories: Record<string, Partial<Memory>>;
}
type Action = AddFactsAction|UpdatingMemoryAction;
// Redux step 2: state
interface PageState {
  facts: {[k: string]: Keyed<Fact>};
  memories: Record<string, Partial<Memory>>;
  // partial because Pouchdb will store deleted docs as {} (exactly so that changes can be picked up)
}
const initialState: PageState = {
  facts: {},
  memories: {}
};
// Redux step 3: reducer
function neverOk(x: never) {};
function reducer(state: PageState = initialState, action: Action): PageState {
  if (action.type === ActionType.addFacts) {
    const o: {[k: string]: Keyed<Fact>} = {};
    for (const f of action.facts) {
      for (const k of f.keys) { o[k] = f; }
    }
    return {...state, facts: {...state.facts, ...o}};
  } else if (action.type === ActionType.updatingMemories) {
    return {...state, memories: {...state.memories, ...action.memories}};
  }
  // Redux actually sends in actions with types I don't know about so I need to return those but I do want to make sure
  // the above if/else ladder covers every action type I know about so this guarantees that
  neverOk(action);
  return state;
}
// Redux step 4: store
const pageStore: Store<PageState, AnyAction> =
    '__REDUX_DEVTOOLS_EXTENSION__' in window ? createStore(reducer, (window as any).__REDUX_DEVTOOLS_EXTENSION__())
                                             : createStore(reducer);

type Db = PouchDB.Database<{}>;
const db: Db = new PouchDB('kaisei');
db.setMaxListeners(50);

enum QuizStateType {
  init = 'init',               // -> picking via action "startQuizSession"
  picking = 'picking',         // -> quizzing via action "startQuiz"
  quizzing = 'quizzing',       // -> feedbacking via action "failQuiz"
                               // -> picking via action "startQuizSession" (either success or if quiz deleted)
                               // -> init via action "doneQuizzing"
  feedbacking = 'feedbacking'  // -> picking via action "startQuizSession"
                               // -> init via action "doneQuizSession"
}
type QuizState_Init = {
  state: QuizStateType.init
};
type QuizState_Picking = {
  state: QuizStateType.picking
};
type QuizState_Quizzing = {
  state: QuizStateType.quizzing,
  action: QuizAction_StartQuiz
};
type QuizState_Feedbacking = {
  state: QuizStateType.feedbacking,
  action: QuizAction_FailQuiz
};
type QuizState = QuizState_Init|QuizState_Picking|QuizState_Quizzing|QuizState_Feedbacking;

enum QuizActionType {
  startQuizSession = 'startQuizSession',
  startQuiz = 'startQuiz',
  failQuiz = 'failQuiz',
  doneQuizSession = 'doneQuizSession',
}
interface QuizAction_StartQuizSession {
  type: QuizActionType.startQuizSession;
}
interface QuizAction_StartQuiz {
  type: QuizActionType.startQuiz;
  fact: Keyed<Fact>;
  quizKey: string;
  parent?: Keyed<SentenceFact>;
}
interface QuizAction_FailQuiz {
  type: QuizActionType.failQuiz;
  fact: Keyed<Fact>;
  quizKey: string;
  parent?: Keyed<SentenceFact>;
  response: string;
}
interface QuizAction_DoneQuizzing {
  type: QuizActionType.doneQuizSession;
}
type QuizAction = QuizAction_StartQuizSession|QuizAction_StartQuiz|QuizAction_FailQuiz|QuizAction_DoneQuizzing;
const quizInitialState: QuizState = {
  state: QuizStateType.init
};

function quizReducer(state: QuizState, action: QuizAction): QuizState {
  if (state.state === QuizStateType.init) {
    if (action.type === QuizActionType.startQuizSession) {
      const newState: QuizState_Picking = {state: QuizStateType.picking};
      return newState;
    }
  } else if (state.state === QuizStateType.picking) {
    if (action.type === QuizActionType.startQuiz) {
      const newState: QuizState_Quizzing = {state: QuizStateType.quizzing, action};
      return newState;
    }
  } else if (state.state === QuizStateType.quizzing) {
    if (action.type === QuizActionType.failQuiz) {
      const newState: QuizState_Feedbacking = {state: QuizStateType.feedbacking, action};
      return newState;
    } else if (action.type === QuizActionType.startQuizSession) {
      const newState: QuizState_Picking = {state: QuizStateType.picking};
      return newState;
    } else if (action.type === QuizActionType.doneQuizSession) {
      const newState: QuizState_Init = {state: QuizStateType.init};
      return newState;
    }
  } else if (state.state === QuizStateType.feedbacking) {
    if (action.type === QuizActionType.startQuizSession) {
      const newState: QuizState_Picking = {state: QuizStateType.picking};
      return newState;
    } else if (action.type === QuizActionType.doneQuizSession) {
      const newState: QuizState_Init = {state: QuizStateType.init};
      return newState;
    }
  } else {
    assertNever(state, 'invalid action for state');
  }
  throw new Error('invalid action for state');
}
const QuizDispatch = createContext(null as unknown as Dispatch<QuizAction>);

// Quiz app: props are all facts on THIS page: this comes from Redux (which we populated in `setup`). Then, from
// Pouchdb, which persists even after browser closes, we load memory models.
function Quiz(props: PageState) {
  const memories = props.memories;
  const [stateMachine, dispatch] = useReducer(quizReducer, quizInitialState);

  // console.log({props, stateMachine})
  const nothing = ce('div', null, 'typescript pacification');
  if (stateMachine.state === QuizStateType.init) {
    const possible = Object.values(memories).filter(o => !!o.ebisu).length;
    if (possible === 0) { return ce('p', null, `Facts known: 0! Learn some!`); }
    const button = ce('button', {onClick: e => dispatch({type: QuizActionType.startQuizSession})}, 'Review!');
    return ce('p', null, `Facts known: ${possible}! Shall we review? `, button);
  } else if (stateMachine.state === QuizStateType.picking) {
    const now = Date.now();
    const status: {min?: [string, Memory]} = {};
    argmin(Object.entries(memories), ([k, m]) => {
      if (m.ebisu) {
        const model = m as Memory;
        const lastSeen = new Date(model.lastSeen).valueOf();
        const elapsedHours = (now - lastSeen) / 3600e3;
        const ret = ebisu.predictRecall(model.ebisu, elapsedHours);
        // console.log({k, ebisu: model.ebisu.join(','), lastseen: model.lastSeen, ret});
        return ret;
      }
      return Infinity;
    }, status);
    const toQuizKeyVal = status.min;
    if (!toQuizKeyVal) { return ce(Fragment, null, 'Nothing to quiz!'); }
    const toQuizKey = toQuizKeyVal[0];
    const fact = toQuizKey in props.facts ? props.facts[toQuizKey] : undefined;
    if (!fact) { return ce(Fragment, null, 'ERROR: best quiz from Pouchdb not in Redux?') }

    const parentKey = toQuizKey.split('/').slice(0, 2).join('/') + '/meaning';
    const parent = props.facts[parentKey];
    const action: QuizAction_StartQuiz = {
      type: QuizActionType.startQuiz,
      fact,
      quizKey: toQuizKey,
      parent: parent && parent.factType === FactType.Sentence ? parent : undefined
    };
    dispatch(action);
    return nothing;
  } else if (stateMachine.state === QuizStateType.quizzing) {
    const {quizKey, fact, parent} = stateMachine.action;
    const memory: Partial<Memory>|undefined = memories[quizKey];
    if (!(memory && memory.ebisu)) {
      // quiz must have been unlearned
      const action: QuizAction_StartQuizSession = {type: QuizActionType.startQuizSession};
      dispatch(action);
      return nothing;
    }
    const props = {quizKey, fact, parent};
    const model = memory.ebisu.join(',');
    return ce('div', null,
              ce('h2', null, `gonna quiz ${quizKey}, model=${model}, last seen=${memories[quizKey].lastSeen}`),
              ce(QuizDispatch.Provider, {value: dispatch as any}, ce(FactQuiz, props)));
  } else if (stateMachine.state === QuizStateType.feedbacking) {
    const button = ce('button', {onClick: e => dispatch({type: QuizActionType.startQuizSession})}, 'Review!');
    return ce('div', null, 'Oops you got that wrong! <insert feedback>. Onward!', button);
  }
  assertNever(stateMachine);
}

interface QuizEvent {
  version: '1';
  modelKey: string;
  active: boolean;
  date: string;
  result: boolean;
  newEbisu: EbisuModel;
  oldEbisu: EbisuModel;
  lastSeen: string;
  extra: Partial<{response: string}>;
}
async function reviewSentence(quizKey: string, result: boolean, response?: string, date?: Date) {
  // if `key = 'model/AAA/reading'`, `superkey = 'model/AAA'`.
  const superkey = quizKey.split('/').slice(0, 2).join('/');
  const res = await db.allDocs({startkey: superkey + '/', endkey: superkey + '/\ufff0'});
  // https://docs.couchdb.org/en/stable/ddocs/views/collation.html#string-ranges

  const relatedKeys = res.rows.map(r => r.id);
  date = date || new Date();
  const now = date.valueOf();
  const stringyDate = date.toISOString();

  // After Ebisu updater (active or passive), the quiz log info will be stored here
  const events: Record<string, QuizEvent> = {};
  const extra: QuizEvent['extra'] = response ? {response} : {};

  // update memory models/timestamps and wait till completion
  await Promise.all(relatedKeys.map(key => {
    return db.upsert(key, (old: {id?: string}&Partial<Memory>) => {
      const ebisuModel = old.ebisu;
      const lastSeen = old.lastSeen;
      if (ebisuModel && lastSeen) {
        let newModel: Memory;
        const active = key === quizKey;
        if (active) {
          const elapsedHours = (now - (new Date(lastSeen)).valueOf()) / 3600e3;
          const newEbisu = ebisu.updateRecall(ebisuModel, result, elapsedHours)
          newModel = {version: '1', ebisu: newEbisu, lastSeen: stringyDate};
        } else {
          newModel = {version: '1', ebisu: ebisuModel, lastSeen: stringyDate};
        }
        // for logging
        events[key] = {
          version: '1',
          modelKey: key,
          active,
          date: stringyDate,
          result,
          newEbisu: newModel.ebisu,
          extra,
          oldEbisu: ebisuModel,
          lastSeen
        };
        return {...old, ...newModel};
      }
      return old;
    });
  }));

  // Then, add new Pouchdb docs documenting this update
  const rand = Math.random().toString(36).slice(2);
  const logPromises = relatedKeys.map((modelKey, i) => {
    const eventKey = `quiz/${stringyDate}-${rand}-${i}`;
    return db.upsert(eventKey, old => ({...old, ...events[modelKey]}))
  });

  return Promise.all(logPromises);
}

function FactQuiz(props: {fact: Keyed<Fact>, quizKey: string, parent?: Keyed<SentenceFact>}) {
  const {fact, quizKey} = props;
  const [input, setInput] = useState('');
  const dispatch = useContext(QuizDispatch);

  if (fact.factType === FactType.Sentence) {
    if (quizKey.endsWith('meaning')) {
      const buttons = [
        ce('button', {
          onClick: async e => {
            await reviewSentence(quizKey, true)
            const action: QuizAction_StartQuizSession = {type: QuizActionType.startQuizSession};
            dispatch(action);
          }
        },
           'Yes!'),
        ce('button', {
          onClick: async e => {
            await reviewSentence(quizKey, false)
            const action: QuizAction_FailQuiz =
                {type: QuizActionType.failQuiz, fact, quizKey, parent: props.parent, response: ''};
            dispatch(action);
          }
        },
           'No')
      ];
      return ce('p', null, 'Do you know what this sentence means? ', ce(FuriganaComponent, {furiganas: fact.furigana}),
                ...buttons);
    } else if (quizKey.endsWith('reading')) {
      const form = ce('input', {type: 'text', value: input, onChange: e => setInput(e.target.value)});
      const submit = ce('button', {
        onClick: async e => {
          const expected = furiganaToHiragana(fact.furigana).replace(/\s/g, '');
          const actual = kata2hira(input);
          const result = expected === actual.replace(/\s/g, '');
          await reviewSentence(quizKey, result, actual);

          if (result) {
            const action: QuizAction_StartQuizSession = {type: QuizActionType.startQuizSession};
            dispatch(action);
          } else {
            const action: QuizAction_FailQuiz =
                {type: QuizActionType.failQuiz, fact, quizKey, parent: props.parent, response: input};
            dispatch(action);
          }
        }
      },
                        'Submit');
      return ce('p', null, 'What is the reading for this sentence? ', furiganaToRuby(fact.furigana), form, submit);
    } else {
      throw new Error('unknown sentence quiz type');
    }
  } else if (fact.factType === FactType.Vocab) {
    if (quizKey.endsWith('meaning')) {
      const buttons = [
        ce('button', {
          onClick: async e => {
            await reviewSentence(quizKey, true)
            const action: QuizAction_StartQuizSession = {type: QuizActionType.startQuizSession};
            dispatch(action);
          }
        },
           'Yes!'),
        ce('button', {
          onClick: async e => {
            await reviewSentence(quizKey, false)
            const action: QuizAction_FailQuiz =
                {type: QuizActionType.failQuiz, fact, quizKey, parent: props.parent, response: ''};
            dispatch(action);
          }
        },
           'No')
      ];
      return ce('p', null, 'Do you know what this vocabulary means? ', fact.kanjiKana.join('・'), ...buttons);
    } else if (quizKey.endsWith('reading')) {
      const form = ce('input', {type: 'text', value: input, onChange: e => setInput(e.target.value)});
      const submit = ce('button', {
        onClick: async e => {
          const expected = fact.kanjiKana.filter(s => !hasKanji(s)).map(kata2hira);
          const actual = kata2hira(input).trim();
          const result = expected.indexOf(actual) >= 0;
          await reviewSentence(quizKey, result, actual);

          if (result) {
            const action: QuizAction_StartQuizSession = {type: QuizActionType.startQuizSession};
            dispatch(action);
          } else {
            const action: QuizAction_FailQuiz =
                {type: QuizActionType.failQuiz, fact, quizKey, parent: props.parent, response: input};
            dispatch(action);
          }
        }
      },
                        'Submit');
      return ce('p', null, 'What is a reading for these kanji? ', fact.kanjiKana.filter(hasKanji).join('・'), form,
                submit);
    } else {
      throw new Error('unknown sentence quiz type');
    }
  } else if (fact.factType === FactType.Conjugated) {
    const {parent} = props;
    if (!parent) { throw new Error('parent not given'); }
    const text = furiganaToRuby(parent.furigana);
    const expected = furiganaToRuby(fact.expected);
    const hidden = text.replace(expected, '■■');
    const form = ce('input', {type: 'text', value: input, onChange: e => setInput(e.target.value)});
    const submit = ce('button', {
      onClick: async e => {
        const actual = kata2hira(input);
        const result = expected === actual.replace(/\s/g, '');
        await reviewSentence(quizKey, result, actual);

        if (result) {
          const action: QuizAction_StartQuizSession = {type: QuizActionType.startQuizSession};
          dispatch(action);
        } else {
          const action: QuizAction_FailQuiz =
              {type: QuizActionType.failQuiz, fact, quizKey, parent: props.parent, response: input};
          dispatch(action);
        }
      }
    },
                      'Submit');
    return ce('p', null, 'Fill in the blank (sorry no furigana yet): ' + hidden + '. Hint: ',
              ce(FuriganaComponent, {furiganas: fact.hints}), form, submit);
  } else if (fact.factType === FactType.Particle) {
    const {parent} = props;
    if (!parent) { throw new Error('parent not given'); }
    const text = furiganaToRuby(parent.furigana);
    const {left, right, cloze} = fact;
    const hidden = text.replace(`${left || ''}${cloze}${right || ''}`, `${left || ''}■■${right || ''}`);
    const form = ce('input', {type: 'text', value: input, onChange: e => setInput(e.target.value)});
    const submit = ce('button', {
      onClick: async e => {
        const actual = kata2hira(input);
        const result = cloze === actual.replace(/\s/g, '');
        await reviewSentence(quizKey, result, actual);

        if (result) {
          const action: QuizAction_StartQuizSession = {type: QuizActionType.startQuizSession};
          dispatch(action);
        } else {
          const action: QuizAction_FailQuiz =
              {type: QuizActionType.failQuiz, fact, quizKey, parent: props.parent, response: input};
          dispatch(action);
        }
      }
    },
                      'Submit');
    return ce('p', null, 'Fill in the blank: ' + hidden, form, submit);
  } else {
    assertNever(fact);
  }
}

function mapStateToProps(state: PageState) { return {...state}; }
const QuizContainer = connect(mapStateToProps, {})(Quiz);
ReactDOM.render(ce(Provider, {store: pageStore}, ce(QuizContainer, null)), document.querySelector('#quiz-app'));
