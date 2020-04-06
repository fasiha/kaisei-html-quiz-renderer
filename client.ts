import {createElement, Fragment, useState} from 'react';
import ReactDOM from 'react-dom';

const ce = createElement;

interface Ruby {
  ruby: string;
  rt?: string;
}
type Furigana = string|Ruby;

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
// 遣る・行る「やる」：① to do/to undertake/to perform/to play (a game)/to study
function textToVocab(s: string): VocabFact {
  const split = s.split('：');
  if (split.length !== 2) { throw new Error('unable to split vocab: ' + s); }
  const kanjiKana = split[0].replace('」', '').replace('「', '・').split('・').filter(s => !!s);  // leading ・
  const definition = split[1];
  return {kanjiKana, definition, factType: FactType.Vocab};
}

interface ConjugatedFact extends BaseFact {
  expected: Furigana[];
  hints: Furigana[];
  factType: FactType.Conjugated;
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

interface ParticleFact extends BaseFact {
  left: string;
  cloze: string;
  right: string;
  factType: FactType.Particle;
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

interface SentenceFact extends BaseFact {
  furigana: Furigana[];
  subfacts: (VocabFact|ParticleFact|ConjugatedFact)[];
  translation: {[lang: string]: string};
  factType: FactType.Sentence;
}
function FuriganaComponent(props: {furiganas: Furigana[]}) {
  return ce(Fragment, null,
            ...props.furiganas.map(o => typeof o === 'string' ? o : ce('ruby', null, o.ruby, ce('rt', null, o.rt))))
}
function Sentence(props: SentenceFact) {
  return ce(Fragment, null, ce('summary', null, ce(FuriganaComponent, {furiganas: props.furigana})),
            'coming soon: ' + props.subfacts.length + ' sub-facts!');
}

export function setup() {
  const details = document.querySelectorAll('details.quizzable');
  for (const detail of details) {
    const sentence = detail.querySelector('.quizzable.sentence');
    if (!sentence) {
      continue;
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
    ReactDOM.render(ce(Sentence, fact), detail);
  }
}