import type { AiRequest } from '../../src/core/ai/request';

/**
 * A scripted model for the exam-generation tests: it reads the plan in the real server-side prompt and answers the way a good model
 * would, one question per planned line, with marking points taken from the slides named. It writes English because the test decks
 * are English; the quality checks it is run against read both languages.
 */
export function scriptedPack(request: Pick<AiRequest, 'system' | 'messages' | 'purpose'>): string {
  if (request.purpose !== 'generate') throw new Error(`the scripted model only writes study packs, not ${request.purpose}`);
  return new ScriptedModel().generate(request.system ?? '', request.messages[request.messages.length - 1]?.content ?? '');
}

class ScriptedModel {
  generate(system: string, escaped: string): string {
    // The server escapes lecture text (& < >) so slides cannot inject prompt structure; a model reads it back fine.
    const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const user = unescape(escaped);
    const m = /<!-- studyai-lecture ref=(\S+) hash=([0-9a-f]+) slides=(\d+) -->/.exec(user);
    const title = /## Lecture \S+: (.*)/.exec(user)?.[1]?.trim() ?? 'Lecture';
    const ref = m?.[1] ?? 'L1';
    // A real quote from slide 1: the first body line under its heading.
    const slide1 = /### Slide 1: [^\n]*\n\n([^\n]+)/.exec(user)?.[1] ?? '';
    const quote = slide1.split(/\s+/).slice(0, 8).join(' ');
    const src = quote ? [{ lecture: ref, slide: 1, quote }] : [];
    return JSON.stringify({
      format: 'studyai-pack',
      version: 1,
      generator: 'scripted test model',
      lectures: [{ ref, title, fileHash: m?.[2] ?? '', slideCount: Number(m?.[3] ?? 1) }],
      cards: [{ type: 'qa', front: 'What does the first slide introduce?', back: 'The topic of the lecture.', lecture: ref, basis: 'lecture', tags: ['intro'], sources: src }],
      notes: [],
      questions: this.plannedQuestions(system, user, ref),
    });
  }

  /**
   * Answers the question plan the way a good model would: one question per planned line with the planned type, marks, number of
   * marking points and topic, the points taken from the slides named, and a model answer that contains every point.
   */
  plannedQuestions(system: string, user: string, ref: string): Record<string, unknown>[] {
    const lines = [...system.matchAll(/^(\d+)\. type "(\w+)", 난이도 ([123]), ([\d.]+)점, 채점 기준 (\d+)개, 주제 "((?:[^"\\]|\\.)*)", 근거 슬라이드 ([\d, ]+)$/gm)];
    if (lines.length === 0) return [];
    const bodies = new Map<number, string[]>();
    for (const s of user.matchAll(/### Slide (\d+): [^\n]*\n\n([\s\S]*?)(?=\n### Slide |\n---\n|$)/g)) {
      bodies.set(
        Number(s[1]),
        s[2]!
          .split('\n')
          .map((l) => l.replace(/^\s*[-*]\s*/, '').replace(/\*\*/g, '').trim())
          .filter((l) => l && !l.startsWith('>') && !l.startsWith('[') && !l.startsWith('Speaker') && !l.startsWith('$')),
      );
    }
    return lines.map((l) => {
      const type = l[2]!;
      const difficulty = Number(l[3]);
      const marks = Number(l[4]);
      const points = Number(l[5]);
      const topic = JSON.parse(`"${l[6]!}"`).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') as string;
      const slides = l[7]!.split(',').map((n) => Number(n.trim()));
      const text = slides.flatMap((n) => bodies.get(n) ?? []);
      const ideas = Array.from({ length: points }, (_, i) => text[i] ?? `Another separate idea about ${topic} (${i + 1})`);
      // like a real model, cite every slide the question is built on, with a quote from it
      const sources = slides.flatMap((n) => {
        const quote = ((bodies.get(n) ?? [])[0] ?? '').split(/\s+/).slice(0, 8).join(' ');
        return quote ? [{ lecture: ref, slide: n, quote }] : [];
      });
      // a distinct hook from the slides the question is built on, so two questions about one topic are not the same question
      const hook = (text[0] ?? topic).split(/\s+/).slice(0, 7).join(' ').replace(/[.,;:]+$/, '');
      const common ={ type, marks, difficulty, topic, lectures: [ref], basis: 'lecture', sources };
      if (type === 'mcq') return { ...common, prompt: `Which statement about ${hook.toLowerCase()} is correct?`, options: [{ text: ideas[0], correct: true }, { text: 'A statement the slides do not make', correct: false }, { text: 'The opposite of what the slides say', correct: false }] };
      if (type === 'truefalse') return { ...common, prompt: `${ideas[0]}`, answer: true };
      // each kind of question is written as that kind, the way the prompt asks a model to
      const n = `${points} separate point${points === 1 ? '' : 's'}`;
      const prompts: Record<string, string> = {
        scenario: `A small organisation is working on "${hook}". Its staff describe a concrete situation that they have run into and ask for advice. Using the ideas from the lecture, state ${n} that apply to this situation and say why each one matters.`,
        case: `Read the following case. A team deals with "${hook}" in a project and runs into trouble, and a colleague asks what went wrong and what to do next. (a) Say what the lecture tells you about it. (b) Give ${n} that would help them.`,
        compare: `Compare the ideas behind "${hook}" on ${n}: say how they differ and what they have in common.`,
        attack: `An attacker targets a system because of "${hook}". Describe the attack in a short situation and give ${n} of defence that the lecture supports.`,
        diagram: `The figure on the slide shows "${hook}". Explain what the figure shows, giving ${n}.`,
        calculation: `Using the method in the lecture for "${hook}", work out the result for a case with 4 items and 12 units, showing ${n} of your working.`,
        problem: `Solve this problem with 3 inputs and 5 steps using the method in the lecture for "${hook}": show ${n}.`,
        proof: `Show that the claim about "${hook}" holds, following the argument in the lecture: give ${n} of the proof.`,
        algorithm: `Trace the steps of the algorithm for "${hook}" on a list of 5 items and give ${n}.`,
        programming: `Write code that carries out the procedure for "${hook}", with ${n} that the lecture names.`,
        define: `Define "${hook}" and say what it is for, in ${n}.`,
        long: `Discuss "${hook}" and its consequences, linking at least the ideas the lecture gives, in ${n}.`,
      };
      const prompt = prompts[type] ?? `Explain "${hook}" using the slides: give ${n}.`;
      // a full-marks answer states each point once, in the student's voice, with a short link to the slides
      return { ...common, prompt, asks: [{ quote: `${points} separate point${points === 1 ? '' : 's'}`, count: points }], modelAnswer: `${ideas.map((i) => `${i}, as the slides state`).join('. ')}.`, rubric: ideas.map((t) => ({ text: t, marks: marks / points, ask: 1 })), expectedWords: [12 * marks, 20 * marks] };
    });
  }
}
