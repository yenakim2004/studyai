# StudyAI 구조

```
 ┌─────────────────────────── 브라우저 (학습 데이터는 모두 여기) ───────────────────────────┐
 │  React 화면 ──► 자료실 (Dexie / IndexedDB)  ◄──► 백업 ZIP (내보내기 / 가져오기)            │
 │     │              │  과목 · 강의 · 슬라이드 · 미디어(Blob) · 원본 파일(Blob)                │
 │     │              └► 검색 (MiniSearch, 슬라이드에서 다시 만듦)                             │
 │     └─ 업로드 ─► Web Worker ─► PPTX 엔진 / PDF ─► ParsedDeck + 보고서                       │
 └───────────────────────────────────────────┬──────────────────────────────────────────────┘
                                             │ 사용자가 AI를 요청하고 동의했을 때만, 같은 주소로
                                   ┌─────────▼──────────┐  pnpm local: 127.0.0.1:<포트>만
                                   │ 로컬 Worker          │  Durable Object (SQLite): ChatGPT 계정(봉인)
                                   │ 루프백 경계 · 계약    │──► OpenAI Responses API (내 ChatGPT 플랜)
                                   └────────────────────┘
```

AI 엔진은 ChatGPT 플랜 하나입니다. `pnpm local`(127.0.0.1 전용)에서만 Worker가 내 ChatGPT 계정으로 로그인하고, Durable Object가 그 계정을 토큰을 봉인한 채로 보관합니다. `worker/src/chatgpt.ts`가 소유합니다. [CHATGPT.md](CHATGPT.md)를 보세요.

## 소스 구성

| 경로 | 역할 |
|---|---|
| `src/core/pptx/` | PPTX → `ParsedDeck` (아래). 순수 TypeScript, 브라우저·Worker·Node에서 동작. |
| `src/core/pdf/` | PDF → 같은 `ParsedDeck`. 쪽마다 화면과 글, 글이 없는 쪽 표시. |
| `src/core/db/` | Dexie 스키마, zod 스키마, 자료실 작업(가져오기, 다시 가져오기, 중복 확인, 삭제, 순서 바꾸기). |
| `src/core/search/` | 슬라이드별 전문 검색과 발췌문 생성. |
| `src/core/study/` | 학습 엔진: 학습 자료 묶음 검사와 인용 확인(`pack.ts`), FSRS 일정과 대기열, 노트, 문제은행, 시험 출제·채점·응시, 진도와 추천, Markdown 내보내기. |
| `src/core/backup/` | 자료실 전체(학습 데이터 포함)를 ZIP 하나로 내보내고 검사해서 가져오기. |
| `src/core/tutor/` | 계약(브라우저가 요청할 수 있는 것), 서버 쪽 프롬프트, 답을 읽는 엄격한 파서, 슬라이드 문맥, 빠진 내용 찾기. |
| `src/core/chatgpt/` | ChatGPT 플랜 프로토콜(로그인, ID 토큰 검증, 갱신, 해지, Responses 스트리밍, 모델 목록)과 고정 한국어 문장. 런타임 중립. |
| `src/core/ai/request.ts` | 프롬프트가 만드는 요청 형식(시스템 문장과 대화). |
| `src/cli/` | 같은 엔진을 쓰는 Node 명령줄 도구(`extract`, `validate`, `prompt`). `dist-cli/lecture-cli.mjs`로 묶음. |
| `src/app/`, `src/ui/`, `src/pages/` | React 앱 틀, 구성 요소, 페이지. |
| `src/demo/`, `src/app/ai.demo.ts` | 공개 정적 데모 전용(`pnpm build:demo`, [DEMO.md](DEMO.md)): 배너, 가상 예시 과목, AI 클라이언트를 대신하는 빈 모듈. 일반 빌드에는 없음. |
| `.claude/skills/lecture-pack/` | Claude Code 스킬: Claude Code 구독으로 강의 → 학습 자료 묶음(API 없음). |
| `worker/` | Worker(루프백 경계, 경로, AI 요청, ChatGPT 돌아오기)와 Durable Object(ChatGPT 계정). |
| `scripts/local.mjs` | `pnpm local`: 로컬 실행기(봉인 키, env 파일, 빌드, 127.0.0.1에서 `wrangler dev`). |

## PPTX 엔진 (하는 일과 하지 않는 일)

처리 순서: `ZipArchive`(한도, CRC) → `parseXml`(DTD 없음, 네임스페이스 정규화) → 프레젠테이션 → 슬라이드마다 레이아웃·마스터 자리 표시자 상속 → 도형 트리 순회 → `SlideData` → 미디어 형식 판별 → 신뢰도 → 주제 → `ExtractionReport`.

슬라이드마다 읽는 것: 제목(자리 표시자, 없으면 위쪽의 가장 큰 글), 글머리 수준이 있는 글 순서, 서식(굵게·기울임·아래·위 첨자·고정폭·링크), 표(병합 포함), 차트 데이터(차트 캐시), SmartArt 글과 추정 계층과 캐시된 그림, 수식(OMML → LaTeX와 한 줄 글), 발표자 노트, 그림(바이트로 실제 MIME 판별), 대체 텍스트, 숨긴 슬라이드·도형, 애니메이션 유무, 레이아웃·마스터 장식(미리 보기용).

출처: 모든 요소에 `{slide, id}`가 있습니다. `SourceRef` = `{lectureId, slide, elementId?, quote?}`는 이후 모든 기능(노트, 플래시카드, 문제, 튜터 답)이 출처를 밝힐 때 쓰는 형식입니다.

정직하게 알리는 장치:
* 제대로 읽지 못한 모든 것에 **표시**(`info` / `warning` / `attention`)를 붙입니다.
* **빠짐없음 규칙:** 슬라이드 XML의 모든 `<a:t>`는 어떤 요소에 들어가야 합니다. 아니면 "배치되지 않은 글"로 남기고 슬라이드를 *신뢰도 낮음*으로 표시합니다.
* **신뢰도:** `high` = 경고 없음, `medium` = 다시 볼 것이 있음(SmartArt, 큰 그림 등), `low` = 내용이 빠짐(그림만 있는 슬라이드, 읽을 수 없는 차트, EMF, OLE, 실패한 슬라이드).
* 보고서는 슬라이드별 "빠졌을 수 있는 내용"과 엔진의 고정된 한계 목록을 보여 줍니다.

알려진 한계(앱 안과 추출 보고서에 표시): EMF/WMF 그림은 표시할 수 없음, 그림 안 글자 OCR 없음, 애니메이션 순서 미수집, SmartArt 배치를 다시 계산하지 않음(캐시된 그림 사용), 세로 글은 가로로 보임.

## 데이터 모델 (IndexedDB)

v1: `courses`, `lectures`(메타데이터와 보고서), `slides`(`[lectureId+index]`), `media`, `files`(다시 가져오기용 원본), `settings`.
v2(추가): `cards`, `reviews`, `notes`, `questions`, `exams`, `attempts`, `packs`(가져오기 기록).
v3(추가): `tutorSessions`, `tutorMessages`(대화, 백업에 포함, 백업 형식 버전 3).
슬라이드 열람 진도는 `viewed:<lectureId>` 설정으로 저장하고, 학습 세션은 저장하지 않고 활동에서 *계산*합니다. AI에 보내는 데 대한 동의(`aiConsentAt:chatgpt`)는 기기에만 두고 백업에 넣지 않습니다.

## 학습 자료 묶음과 출처 확인

AI가 만든 자료는 `studyai-pack` v1 JSON 문서로만 들어옵니다.

```
강의 내보내기(Markdown, 슬라이드 번호 유지) ─► AI(Claude Code 스킬이나 아무 채팅, 또는 앱의 ChatGPT 튜터) ─► 묶음 JSON
묶음 JSON ─► extractJson ─► 항목마다 zod ─► 강의 연결(해시 → 제목 → 직접)
          ─► 실제 슬라이드 글에서 인용 찾기 ─► `pending`으로 저장 ─► 내가 승인
```

* 묶음은 믿을 수 없는 입력입니다. 나쁜 항목은 건너뛰고 목록으로 보여 주며, 좋은 항목은 그대로 가져옵니다.
* 인용은 정규화한 형태(Markdown, LaTeX 명령, 문장 부호 제거)가 인용한 슬라이드의 정규화한 글에 있으면 찾은 것으로 칩니다. 인용 속 "..."는 단어를 건너뜁니다.
* `basis`는 `lecture | derived | outside | uncertain` 가운데 하나입니다. 인용을 찾지 못한 `lecture` 주장은 낮춰서("확인 안 됨") 보여 줍니다. 확인은 인용이 있다는 것만 증명하며, 항목이 잘 만들어졌다는 뜻은 **아닙니다**.
* 같은 `validate` 논리가 명령줄 도구에서도 돌아서, 스킬은 가져오기 전에 묶음을 거절할 수 있습니다.

## 로컬 AI 서버 (Worker + Durable Object 하나)

```
 브라우저 (학습 데이터는 여기)                        내 컴퓨터, pnpm local
 ─────────────────────────────                        ──────────────────────────────────────────────
 튜터 / 생성 / 채점 화면 ── 같은 주소 ──────────────►  Worker (/api/*와 /auth/*만, 나머지는 정적 파일)
   "보낼 내용"을 먼저 보여 줌                             │ Host 정확히 127.0.0.1:<포트> · Origin/Fetch-Metadata
   슬라이드 발췌를 기기에서 만듦                          │ 엄격한 요청 계약(zod) · 크기 제한 · JSON 본문
                                                         ▼
                                                 Durable Object "owner" (SQLite, 인스턴스 하나)
                                                   ChatGPT 계정: 등록, 봉인한 토큰, 모델, 멈춤
                                                   프롬프트를 만들고 모델을 고름
                                                         │
                                                         ▼
                                                 OpenAI Responses API (store: false, 스트리밍)
```

* `worker/src/app.ts`: 경로와 모든 입구 검사. Cloudflare를 가져오지 않아 Node에서 단위 테스트합니다.
* `worker/src/loopback.ts`: "이 서버는 로컬 실행기"라는 단 하나의 판단과 API 경계, 돌아오기 페이지.
* `worker/src/do.ts`: Durable Object. 저장소 행과 ChatGPT 계정을 잇는 얇은 층입니다. Durable Object 이름 `owner`는 첫 버전부터 쓰던 저장 주소라서 그대로 둡니다. 이전 버전이 남긴 다른 행은 읽지 않습니다.
* `worker/src/chatgpt.ts`: ChatGPT 계정의 유일한 소유자(로그인, 봉인, 갱신, 해지, 멈춤, 모델).
* `worker/src/test-entry.ts`: 가짜 OpenAI 발급자로 주소를 옮기는 로컬 테스트 입구. 운영 입구는 가져오지 않습니다(번들 테스트가 확인).
* `src/app/ai.ts`, `src/ui/ai/*`, `src/pages/TutorPage.tsx`: 브라우저 쪽. 대화는 IndexedDB(스키마 v3)와 백업에 있고 서버는 아무것도 보관하지 않습니다.

AI 기능은 로컬 기능을 대신하지 않습니다. AI 답은 내가 저장할 때만 노트나 *대기 중* 플래시카드가 되고, 생성한 묶음은 일반 묶음 검사(실제 슬라이드에서 인용 확인, 내 승인)를 거치며, AI 채점은 "AI 추정"으로 저장되어 내가 바꿀 수 있습니다.

## 시험 엔진

출제는 시드가 있어 다시 만들 수 있고, 강의·종류·난이도로 거르며, 요청한 배점을 목표로 합니다. 객관식과 참거짓은 정확히 채점합니다. 서술형은 채점 기준으로 **스스로 채점**하며, 키워드 일치는 점수 제안일 뿐이고 모든 서술형 점수는 `uncertain`으로 저장합니다. 응시는 바뀔 때마다 자동 저장되어 새로 고침 뒤에도 이어지고, "시험 조건"은 힌트와 미리 보는 답을 없애고 시간을 계속 잽니다.
