import {hasKanji} from 'curtiz-utils';
import PouchDB from 'pouchdb';
import {createElement, Fragment, useEffect, useState} from 'react';
import ReactDOM from 'react-dom';

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
function ParticleComponent(props: {fact: ParticleFact, parentSentenceId: string}) {
  const {left, right, cloze} = props.fact;

  const particleKey = [left, cloze, right].join('_');
  const dbKey = `model/${props.parentSentenceId}/particle/${particleKey}`;
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
    }

    const changes = db.changes({since: 'now', live: true, doc_ids: [dbKey]}).on('change', change => {
      if (typeof learned === 'undefined') { return; }  // if setLearned hasn't yet updated the state, just bail
      setLearned(!change.deleted);
      // TODO this might not be necessary, i.e., if just a key changed
    });
    return () => changes.cancel();  // to cancel the listener when component unmounts.
  })

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
function ConjugatedComponent(props: {fact: ConjugatedFact}) {
  return ce(Fragment, null, props.fact.expected, '：', ce(FuriganaComponent, {furiganas: props.fact.hints}))
}

function Sentence(props: {fact: SentenceFact}) {
  type BoolDict = {[k: string]: boolean};
  const [learned, setLearned] = useState(undefined as undefined | BoolDict);

  // the following block is a candidate for `useMemo`.
  const text = furiganaToString(props.fact.furigana);
  if (text.includes('/')) { throw new Error('unhandled: text containing separator'); }
  const dbKeys = [`model/${text}/meaning`];
  if (hasKanji(text)) { dbKeys.push(`model/${text}/reading`); }

  useEffect(() => {
    if (!learned) {
      async function init(dbKeys: string[]) {
        const learned: BoolDict = {};
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

  const buttons = learned ? dbKeys.map(key => {
    const thisLearned = learned[key] ? 'unlearn' : 'learn!';
    const display = key.endsWith('meaning') ? 'Meaning' : 'Reading';
    return ce('button', {onClick: e => learnUnlearn(key, !(learned[key]))}, `${display} ${thisLearned}`);
  })
                          : [];

  return ce(
      Fragment,
      null,
      ce('summary', null, ce(FuriganaComponent, {furiganas: props.fact.furigana})),
      ...buttons,
      ce(
          'ul',
          null,
          ...props.fact.subfacts.map(fact => ce('li', null,
                                                fact.factType === FactType.Vocab
                                                    ? ce(VocabComponent, {fact})
                                                    : fact.factType === FactType.Particle
                                                          ? ce(ParticleComponent, {fact, parentSentenceId: text})
                                                          : ce(ConjugatedComponent, {fact}))),
          ),
  );
}

function learnUnlearn(key: string, learn: boolean) {
  return db.upsert(key, old => learn ? {...old, learned: true} : {...old, _deleted: true});
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
    const factNodes = detail.querySelectorAll('.quizzable:not(.sentence)');
    const subfacts = Array.from(factNodes, elt => elementToFact(elt));
    const translation: {[s: string]: string} = {};
    for (const elt of detail.querySelectorAll('.translation')) {
      const lang = Array.from(elt.classList).find(s => s !== 'translation') || 'pacification';
      translation[lang] = elt.textContent || 'pacification 2';
    }

    const fact: SentenceFact = {furigana, subfacts, translation, factType: FactType.Sentence};
    console.log(fact);
    ReactDOM.render(ce(Sentence, {fact}), detail);
  }
}

type Db = PouchDB.Database<{}>;
const db: Db = new PouchDB('kaisei');
