import { resolve } from 'node:path';
import { defaultPromptOptions, extractLectures, formatExtraction, promptText, validatePackFile } from './commands';

const HELP = `StudyAI 강의 도구 (로컬 전용, 네트워크·AI 호출 없음)

  extract <file.pptx>... --out <dir>
      PowerPoint 강의를 슬라이드 번호가 있는 Markdown으로 변환하고 추출 보고서를 저장합니다.
      PDF 가져오기는 웹 앱에서 지원합니다.
  validate <pack.json> --lectures <file.pptx>...
      실제 슬라이드와 학습 팩의 형식, 강의 연결, 인용문을 대조합니다.
      누락된 항목이 없고 모든 인용문이 확인된 경우에만 종료 코드 0을 반환합니다.
  prompt [--exam-style "<text>"] [--amount few|normal|many] [--only notes,cards,questions]
      강의 Markdown과 함께 AI에 전달할 한국어 지시문을 출력합니다.
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Values after `name` up to the next --flag. */
function many(args: string[], name: string): string[] {
  const i = args.indexOf(name);
  if (i < 0) return [];
  const out: string[] = [];
  for (let j = i + 1; j < args.length && !args[j]!.startsWith('--'); j++) out.push(args[j]!);
  return out;
}

async function run(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(HELP);
    return 0;
  }
  if (cmd === 'extract') {
    const out = flag(rest, '--out');
    const files = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--out');
    if (!out || files.length === 0) {
      console.error('사용법: extract <file.pptx>... --out <dir>');
      return 2;
    }
    const results = await extractLectures(files.map((f) => resolve(f)), resolve(out));
    console.log(formatExtraction(results));
    return 0;
  }
  if (cmd === 'validate') {
    const pack = rest.find((a) => !a.startsWith('--'));
    const lectures = many(rest, '--lectures');
    if (!pack || lectures.length === 0) {
      console.error('사용법: validate <pack.json> --lectures <file.pptx>...');
      return 2;
    }
    const r = await validatePackFile(resolve(pack), lectures.map((f) => resolve(f)));
    console.log(r.report);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'prompt') {
    const amount = flag(rest, '--amount');
    const only = flag(rest, '--only')?.split(',');
    console.log(
      promptText({
        ...defaultPromptOptions,
        examStyle: flag(rest, '--exam-style'),
        amount: amount === 'few' || amount === 'many' ? amount : 'normal',
        wants: only ? { notes: only.includes('notes'), cards: only.includes('cards'), questions: only.includes('questions') } : defaultPromptOptions.wants,
      }),
    );
    return 0;
  }
  console.error(`알 수 없는 명령: ${cmd}\n\n${HELP}`);
  return 2;
}

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
