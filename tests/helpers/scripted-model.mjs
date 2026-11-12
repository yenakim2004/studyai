/**
 * TEST ONLY. A scripted stand-in for the ChatGPT model behind the fake issuer (tests/helpers/fake-openai.mjs), used by
 * scripts/e2e-worker-server.mjs. It reads the Responses body the Worker sent (`instructions` and `input`) and answers the
 * way a good model would, so the browser tests exercise the tutor, the question generator, the grader and the marking
 * check end to end. Words in the student's last message trigger failures:
 *   FAKE-USAGE-LIMIT  the plan's usage limit (429 subscription_sharing_usage_limit_exceeded), which pauses AI
 *   FAKE-RATE-LIMIT   a plain 429
 *   FAKE-500          an upstream server error
 *   FAKE-NOCITE       a confident answer with no citation
 *   FAKE-OUTSIDE      an answer that goes beyond the slides
 * A marking point with FAKE-NOT-ASKED or FAKE-PARTLY, and a scenario question with FAKE-DECORATION, steer the marking check.
 */

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function tutor(system, question) {
  const refs = [...system.matchAll(/<excerpt ref="(S\d+)"/g)].map((m) => m[1]);
  const cite = refs[0] ? ` [${refs[0]}]` : '';
  if (question.includes('FAKE-OUTSIDE')) return `Short answer${cite}.\n\nBeyond the slides: this connects to complexity theory.\n\nBASIS: lecture\nFOLLOWUPS: What is complexity? | Why does it matter?`;
  if (question.includes('FAKE-NOCITE')) return 'A confident answer with no citation at all.\n\nBASIS: lecture\nFOLLOWUPS: Why? | How?';
  return `A Turing machine reads and writes symbols on an infinite tape${cite}. Each step it moves the head left or right${refs[1] ? ` [${refs[1]}]` : ''}.\n\nBASIS: lecture\nFOLLOWUPS: What is the head? | What is a transition function? | Can the tape be finite?`;
}

function grade(user) {
  const ids = [...user.matchAll(/<rubric>[\s\S]*?<\/rubric>/g)].flatMap((m) => [...m[0].matchAll(/id="([^"]+)" marks=([0-9.]+)/g)].map((x) => ({ id: x[1], marks: Number(x[2]) })));
  const answer = /<student_answer>([\s\S]*?)<\/student_answer>/.exec(user)?.[1]?.trim() ?? '';
  // First point earned when the answer is not empty; the rest only when the answer is long. A real grader would read it.
  const points = ids.map((p, i) => ({ id: p.id, awarded: answer.length > 3 && (i === 0 || answer.length > 60) ? p.marks : 0, reason: i === 0 ? 'The core idea is present.' : 'Detail is missing.' }));
  return JSON.stringify({ points, feedback: 'Add the missing detail and a concrete example.', missing: ['a worked example'], confidence: 'medium' });
}

function audit(escaped) {
  const user = unescape(escaped);
  const questions = [...user.matchAll(/<question n="(\d+)" type="(\w+)" marks="[\d.]+">\n([\s\S]*?)\n<\/question>\n<marking_points>\n([\s\S]*?)\n<\/marking_points>/g)].map((m) => {
    const prompt = m[3];
    const quote = prompt.split(/\s+/).slice(0, 6).join(' ');
    const points = m[4].split('\n').map((line, i) => {
      const asked = line.includes('FAKE-NOT-ASKED') ? 'no' : line.includes('FAKE-PARTLY') ? 'partly' : 'yes';
      return { point: i + 1, asked, quote: asked === 'yes' ? quote : '', note: asked === 'no' ? 'The question never asks for this.' : asked === 'partly' ? 'The question asks for something related.' : '' };
    });
    return { n: Number(m[1]), points, situation: m[2] === 'scenario' || m[2] === 'case' || m[2] === 'attack' ? (prompt.includes('FAKE-DECORATION') ? 'decoration' : 'needed') : 'n/a' };
  });
  return JSON.stringify({ questions });
}

/**
 * Answers the question plan the way a good model would: one question per planned line with the planned type, marks, number of
 * marking points and topic, the points taken from the slides named, and a model answer that contains every point.
 */
function plannedQuestions(system, user, ref) {
  const lines = [...system.matchAll(/^(\d+)\. type "(\w+)", 난이도 ([123]), ([\d.]+)점, 채점 기준 (\d+)개, 주제 "((?:[^"\\]|\\.)*)", 근거 슬라이드 ([\d, ]+)$/gm)];
  if (lines.length === 0) return [];
  const bodies = new Map();
  for (const s of user.matchAll(/### Slide (\d+): [^\n]*\n\n([\s\S]*?)(?=\n### Slide |\n---\n|$)/g)) {
    bodies.set(
      Number(s[1]),
      s[2]
        .split('\n')
        .map((l) => l.replace(/^\s*[-*]\s*/, '').replace(/\*\*/g, '').trim())
        .filter((l) => l && !l.startsWith('>') && !l.startsWith('[') && !l.startsWith('Speaker') && !l.startsWith('$')),
    );
  }
  return lines.map((l) => {
    const type = l[2];
    const difficulty = Number(l[3]);
    const marks = Number(l[4]);
    const points = Number(l[5]);
    const topic = unescape(JSON.parse(`"${l[6]}"`));
    const slides = l[7].split(',').map((n) => Number(n.trim()));
    const text = slides.flatMap((n) => bodies.get(n) ?? []);
    const ideas = Array.from({ length: points }, (_, i) => text[i] ?? `Another separate idea about ${topic} (${i + 1})`);
    const sources = slides.flatMap((n) => {
      const quote = ((bodies.get(n) ?? [])[0] ?? '').split(/\s+/).slice(0, 8).join(' ');
      return quote ? [{ lecture: ref, slide: n, quote }] : [];
    });
    const hook = (text[0] ?? topic).split(/\s+/).slice(0, 7).join(' ').replace(/[.,;:]+$/, '');
    const common = { type, marks, difficulty, topic, lectures: [ref], basis: 'lecture', sources };
    if (type === 'mcq') return { ...common, prompt: `Which statement about ${hook.toLowerCase()} is correct?`, options: [{ text: ideas[0], correct: true }, { text: 'A statement the slides do not make', correct: false }, { text: 'The opposite of what the slides say', correct: false }] };
    if (type === 'truefalse') return { ...common, prompt: `${ideas[0]}`, answer: true };
    const n = `${points} separate point${points === 1 ? '' : 's'}`;
    const prompts = {
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
    return { ...common, prompt, asks: [{ quote: n, count: points }], modelAnswer: `${ideas.map((i) => `${i}, as the slides state`).join('. ')}.`, rubric: ideas.map((t) => ({ text: t, marks: marks / points, ask: 1 })), expectedWords: [12 * marks, 20 * marks] };
  });
}

function generate(system, escaped) {
  const user = unescape(escaped);
  const m = /<!-- studyai-lecture ref=(\S+) hash=([0-9a-f]+) slides=(\d+) -->/.exec(user);
  const title = /## Lecture \S+: (.*)/.exec(user)?.[1]?.trim() ?? 'Lecture';
  const ref = m?.[1] ?? 'L1';
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
    questions: plannedQuestions(system, user, ref),
  });
}

/** One Responses request in, one FakeScript out. */
export function scriptedModel(body) {
  const system = body.instructions ?? '';
  const last = body.input?.at(-1)?.content ?? '';
  if (last.includes('FAKE-USAGE-LIMIT')) return { kind: 'http', status: 429, body: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'usage limit' } } };
  if (last.includes('FAKE-RATE-LIMIT')) return { kind: 'http', status: 429, body: { error: { code: 'rate_limit_exceeded', message: 'slow down' } } };
  if (last.includes('FAKE-500')) return { kind: 'http', status: 500, body: { error: { code: 'server_error', message: 'boom' } } };
  // Told apart by the delimited blocks prompts.ts puts in the user message, not by prose that may be reworded or translated.
  const text = last.includes('<student_answer>') ? grade(last) : last.includes('<marking_points>') ? audit(last) : last.includes('<lecture_export>') ? generate(system, last) : tutor(system, last);
  return { kind: 'text', text };
}
