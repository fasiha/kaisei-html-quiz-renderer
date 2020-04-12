import {argmin, hasKanji} from 'curtiz-utils';
import * as ebisu from 'ebisu-js';
import PouchDB from 'pouchdb';
import {createElement, Fragment, useEffect, useState} from 'react';
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

function furiganaToString(v: Furigana[]): string {
  return v.map(o => typeof o === 'string' ? o : o.ruby).join('').trim();
}

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

function VocabComponent(props: {fact: VocabFact}) {
  return ce(Fragment, null, props.fact.kanjiKana.join('・'), '：', props.fact.definition);
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
}
function learnUnlearn(key: string, learn: boolean, date?: Date) {
  return db.upsert(key, old => {
    if (!learn) { return {...old, _deleted: true}; }
    const halflife = 0.5;  // hours
    const ab = 3;          // unitless
    // the initial prior on recall probability will be Beta(ab, ab) in `halflife` time units. Instead of tweaking the
    // halflife when you first learn a fact, let's let users tweak it after a review.
    const model: Memory = {ebisu: ebisu.defaultModel(halflife, ab), lastSeen: (date || new Date()).toISOString()};
    return {...old, ...model};
  });
}

export function setup() {
  const details = document.querySelectorAll('details.quizzable');
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
  }
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
  const text = furiganaToString(sentence.furigana);
  if (text.includes('/')) { throw new Error('unhandled: text containing separator'); }
  const keys = [`model/${text}/meaning`];
  if (hasKanji(text)) { keys.push(`model/${text}/reading`); }

  const orig = sentence.subfacts;
  const subfacts: Keyed1<(typeof orig)[number]>[] = orig.map(o => {
    if (o.factType === FactType.Conjugated) {
      return { ...o, keys: [`model/${text}/conjugated/${furiganaToString(o.expected)}`] }
    } else if (o.factType === FactType.Particle) {
      const particleKey = [o.left, o.cloze, o.right].join('_');
      return { ...o, keys: [`model/${text}/particle/${particleKey}`] }
    } else if (o.factType === FactType.Vocab) {
      return { ...o, keys: [] }
    }
    assertNever(o);
  });
  return {...sentence, subfacts, keys};
}
function assertNever(x: never): never { throw new Error("Unexpected object: " + x); }

// Redux step 1: actions
enum ActionType {
  addFacts = 'addFacts',
}
interface AddFactsAction {
  type: ActionType.addFacts;
  facts: Keyed<Fact>[];
}
type Action = AddFactsAction;
// Redux step 2: state
interface PageState {
  facts: {[k: string]: Keyed<Fact>};
}
const initialState: PageState = {
  facts: {}
};
// Redux step 3: reducer
function reducer(state: PageState = initialState, action: Action) {
  if (action.type === ActionType.addFacts) {
    const o: {[k: string]: Keyed<Fact>} = {};
    for (const f of action.facts) {
      for (const k of f.keys) { o[k] = f; }
    }
    return {facts: {...state.facts, ...o}};
  }
  return state;
}
// Redux step 4: store
const pageStore: Store<PageState, AnyAction> =
    '__REDUX_DEVTOOLS_EXTENSION__' in window ? createStore(reducer, (window as any).__REDUX_DEVTOOLS_EXTENSION__())
                                             : createStore(reducer);

type Db = PouchDB.Database<{}>;
const db: Db = new PouchDB('kaisei');
db.setMaxListeners(50);

// Quiz app: props are all facts on THIS page: this comes from Redux (which we populated in `setup`). Then, from Poucdb,
// which persists even after browser closes, we load memory models.
function Quiz(props: PageState) {
  const dbKeys = Object.keys(props.facts);
  const [learned, setLearned] = useState(undefined as undefined | Record<string, Partial<Memory>>);

  useEffect(() => {
    if (!learned || (Object.keys(learned).length !== dbKeys.length)) {
      async function init(dbKeys: string[]) {
        const learned: Record<string, Partial<Memory>> = {};
        for (const key of dbKeys) {
          try {
            const model = await db.get(key) as Memory;
            learned[key] = model;
          } catch { learned[key] = {}; }
        }
        setLearned(learned);
      }
      init(dbKeys);
    }

    const changes = db.changes({since: 'now', live: true, doc_ids: dbKeys, include_docs: true}).on('change', change => {
      if (!learned) { return; }  // if setLearned hasn't yet updated the state, just bail
      if (change.deleted) {
        setLearned({...learned, [change.id]: {}});
        return;
      }
      setLearned({...learned, [change.id]: change.doc as unknown as Memory});
    });
    return () => changes.cancel();  // to cancel the listener when component unmounts.
  });

  if (!learned) { return ce(Fragment, null, ''); }

  const now = Date.now();
  const status: {min?: [string, Memory]} = {};
  argmin(Object.entries(learned), ([k, m]) => {
    if (m.ebisu) {
      const model = m as Memory;
      const lastSeen = new Date(model.lastSeen).valueOf();
      const elapsedHours = (now - lastSeen) / 3600e3;
      const ret = ebisu.predictRecall(model.ebisu, elapsedHours);
      return ret;
    }
    return Infinity;
  }, status);
  const toQuizKeyVal = status.min;
  if (!toQuizKeyVal) { return ce(Fragment, null, 'Nothing to quiz!'); }
  const toQuizKey = toQuizKeyVal[0];
  const fact = toQuizKey in props.facts ? props.facts[toQuizKey] : undefined;
  if (!fact) { return ce(Fragment, null, 'ERROR: best quiz from Pouchdb not in Redux?') }

  if (fact.factType === FactType.Particle || fact.factType === FactType.Conjugated) {
    const parentKey = toQuizKey.split('/').slice(0, 2).join('/') + '/meaning';
    const parent = props.facts[parentKey];
    if (parent && parent.factType === FactType.Sentence) {
      return ce('div', null, ce('h2', null, 'gonna quiz ' + toQuizKey),
                ce(FactQuiz, {fact, quizKey: toQuizKey, parent}));
    }
    return ce('div', null, 'Failed to find parent');
  } else if (fact.factType === FactType.Vocab) {
    return ce('div', null, ce('h2', null, 'gonna quiz ' + toQuizKey), ce(FactQuiz, {fact, quizKey: toQuizKey}));
  } else if (fact.factType === FactType.Sentence) {
    return ce('div', null, ce('h2', null, 'gonna quiz ' + toQuizKey), ce(FactQuiz, {fact, quizKey: toQuizKey}));
  } else {
    assertNever(fact);
  }
}

function FactQuiz(props: {fact: Keyed<Fact>, quizKey: string, parent?: Keyed<SentenceFact>}) {
  const {fact, quizKey} = props;
  if (fact.factType === FactType.Sentence) {
    if (quizKey.endsWith('meaning')) {
      return ce('p', null, 'Do you know what this sentence means? ', ce(FuriganaComponent, {furiganas: fact.furigana}));
    } else if (quizKey.endsWith('reading')) {
      return ce('p', null, 'Do you know the reading for this sentence? ', furiganaToString(fact.furigana));
    } else {
      throw new Error('unknown sentence quiz type');
    }
  } else if (fact.factType === FactType.Vocab) {
    return ce('p', null, 'unimplemented');
  } else if (fact.factType === FactType.Conjugated) {
    const {parent} = props;
    if (!parent) { throw new Error('parent not given'); }
    const text = furiganaToString(parent.furigana);
    const hidden = text.replace(furiganaToString(fact.expected), '■■■■■■');
    return ce('p', null, 'Fill in the blank: ' + hidden + '. Hint: ', ce(FuriganaComponent, {furiganas: fact.hints}));
  } else if (fact.factType === FactType.Particle) {
    const {parent} = props;
    if (!parent) { throw new Error('parent not given'); }
    const text = furiganaToString(parent.furigana);
    const {left, right, cloze} = fact;
    const hidden = text.replace(`${left || ''}${cloze}${right || ''}`, '■■■');
    return ce('p', null, 'Fill in the blank: ' + hidden);
  } else {
    assertNever(fact);
  }
}

function mapStateToProps(state: PageState) { return {facts: state.facts}; }
const QuizContainer = connect(mapStateToProps, {})(Quiz);
ReactDOM.render(ce(Provider, {store: pageStore}, ce(QuizContainer, null)), document.querySelector('#quiz-app'));
